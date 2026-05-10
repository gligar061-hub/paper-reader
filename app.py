import os, json, uuid, tempfile, asyncio, re, time
from contextlib import asynccontextmanager
from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import StreamingResponse, FileResponse
from openai import OpenAI
import pdfplumber

sessions: dict = {}


async def _cleanup_sessions():
    while True:
        await asyncio.sleep(1800)
        cutoff = time.time() - 7200
        expired = [sid for sid, s in list(sessions.items())
                   if s.get("created_at", 0) < cutoff]
        for sid in expired:
            path = sessions[sid].get("pdf_path", "")
            if path and os.path.exists(path):
                os.unlink(path)
            del sessions[sid]


@asynccontextmanager
async def lifespan(_: FastAPI):
    asyncio.create_task(_cleanup_sessions())
    yield


app = FastAPI(lifespan=lifespan)

STOP_RE = re.compile(
    r'^\s*(references?|bibliography|appendix[:\s]|acknowledgment|acknowledgement'
    r'|supplementary material|conflict of interest|funding|data availability)',
    re.IGNORECASE,
)


def extract_page_texts(pdf_path: str) -> list[dict]:
    pages = []
    with pdfplumber.open(pdf_path) as pdf:
        for page_num, page in enumerate(pdf.pages, 1):
            h, w = page.height, page.width
            body = page.crop((0, h * 0.07, w, h * 0.93))
            text = body.extract_text()
            if not text or len(text.strip()) < 50:
                continue
            # Repair hyphenated line breaks
            text = re.sub(r"-\n", "", text)
            # Stop at references / appendix
            if STOP_RE.match(text.strip()):
                break
            pages.append({"text": text, "page": page_num})
    return pages[:20]


def analyze_page(client: OpenAI, page: dict, page_idx: int) -> dict:
    prompt = f"""你是学术文献处理助手。以下是从学术PDF某页提取的原始文字（含换行符，反映原文排版）。

请完成：
1. 识别并划分段落和标题，尽量还原原文排版结构
2. 翻译每个段落（标题保留英文即可，无需翻译）
3. 对每个段落提取加粗重点和一句话批注

原始文字：
{page["text"]}

返回严格JSON（无其他内容）：
{{
  "segments": [
    {{
      "type": "heading",
      "en": "原始英文标题文字"
    }},
    {{
      "type": "paragraph",
      "en": "还原的完整英文段落",
      "zh": "完整中文翻译",
      "bold_zh": ["需加粗的中文短语或句子"],
      "annotation": "一句话概括（30字以内）"
    }}
  ]
}}

划分规则：
- 独立成行的章节标题（"Abstract"、"1. Introduction"、"2.1 Methods" 等）→ type: heading
- 全大写或明显是标题的短行 → type: heading
- 其余正文内容 → type: paragraph，将属于同一段落的多行合并
- bold_zh：5-10个关键短语/句子，必须是zh字段的精确子字符串
- 忽略页码、期刊名、作者行等版面无关元素"""

    resp = client.chat.completions.create(
        model="deepseek-chat",
        messages=[{"role": "user", "content": prompt}],
        response_format={"type": "json_object"},
        temperature=0.1,
        max_tokens=3000,
    )
    result = json.loads(resp.choices[0].message.content)
    result["page"] = page["page"]
    result["page_idx"] = page_idx
    return result


@app.post("/api/upload")
async def upload_pdf(file: UploadFile = File(...), api_key: str = Form(...)):
    if not file.filename.lower().endswith(".pdf"):
        raise HTTPException(400, "请上传 PDF 文件")
    content = await file.read()
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".pdf")
    tmp.write(content)
    tmp.close()

    try:
        pages = extract_page_texts(tmp.name)
    except Exception as e:
        os.unlink(tmp.name)
        raise HTTPException(400, f"PDF 解析失败：{e}")

    if not pages:
        os.unlink(tmp.name)
        raise HTTPException(400, "无法提取文本，请确认 PDF 含有可复制文字（非扫描图片）")

    session_id = str(uuid.uuid4())
    sessions[session_id] = {
        "pages": pages,
        "api_key": api_key,
        "pdf_path": tmp.name,
        "created_at": time.time(),
    }
    return {"session_id": session_id, "total": len(pages)}


@app.get("/api/pdf/{session_id}")
async def serve_pdf(session_id: str):
    path = sessions.get(session_id, {}).get("pdf_path", "")
    if not path or not os.path.exists(path):
        raise HTTPException(404, "PDF not found")
    return FileResponse(path, media_type="application/pdf",
                        headers={"Cache-Control": "no-store"})


@app.get("/api/stream/{session_id}")
async def stream(session_id: str):
    if session_id not in sessions:
        raise HTTPException(404)
    session = sessions[session_id]

    async def generate():
        client = OpenAI(api_key=session["api_key"], base_url="https://api.deepseek.com")
        for i, page in enumerate(session["pages"]):
            try:
                result = await asyncio.to_thread(analyze_page, client, page, i)
            except Exception as e:
                result = {
                    "page": page["page"], "page_idx": i,
                    "segments": [{
                        "type": "paragraph", "en": page["text"],
                        "zh": f"处理失败：{e}", "bold_zh": [],
                        "annotation": "（处理失败）",
                    }],
                    "error": True,
                }
            yield f"data: {json.dumps(result, ensure_ascii=False)}\n\n"
        yield 'data: {"done":true}\n\n'

    return StreamingResponse(
        generate(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


app.mount("/", StaticFiles(directory="static", html=True), name="static")
