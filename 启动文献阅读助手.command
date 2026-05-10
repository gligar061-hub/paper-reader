#!/bin/bash
# 文献阅读助手 - 双击即可启动
# 关闭此窗口即停止服务

PORT=8765
DIR="$(cd "$(dirname "$0")" && pwd)"
VENV="$DIR/.venv"

echo "============================================"
echo "        文献阅读助手 · Literature Reader"
echo "============================================"
echo ""

# 如果端口已被占用，直接打开浏览器
if lsof -ti tcp:$PORT &>/dev/null; then
  echo "✅ 服务已在运行，正在打开浏览器..."
  open "http://127.0.0.1:$PORT"
  echo ""
  echo "关闭此窗口不会停止已运行的服务。"
  echo "如需停止，请运行：kill \$(lsof -ti tcp:$PORT)"
  exit 0
fi

cd "$DIR"

# 检查 Python 3
PYTHON=$(command -v python3)
if [ -z "$PYTHON" ]; then
  echo "❌ 未找到 Python 3，请先安装 Python 3.8+"
  read -p "按回车键退出..."
  exit 1
fi
PY_VER=$($PYTHON -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
echo "🐍 Python $PY_VER"

# 创建虚拟环境（首次运行）
if [ ! -d "$VENV" ]; then
  echo "📦 创建虚拟环境..."
  $PYTHON -m venv "$VENV"
  if [ $? -ne 0 ]; then
    echo "❌ 虚拟环境创建失败"
    read -p "按回车键退出..."
    exit 1
  fi
fi

source "$VENV/bin/activate"

# 安装依赖（先尝试正常方式，失败则用 trusted-host）
echo "🔍 检查 Python 依赖..."
pip install --quiet fastapi "uvicorn[standard]" python-multipart pdfplumber openai 2>&1
if [ $? -ne 0 ]; then
  echo "⚠️  标准安装失败，尝试备用方式..."
  pip install --trusted-host pypi.org --trusted-host files.pythonhosted.org \
    fastapi "uvicorn[standard]" python-multipart pdfplumber openai -q 2>&1
  if [ $? -ne 0 ]; then
    echo "❌ 依赖安装失败，请检查网络连接或 Python 版本"
    read -p "按回车键退出..."
    exit 1
  fi
fi
echo "✅ 依赖就绪"
echo ""

# 启动服务
echo "🚀 启动服务（端口 $PORT）..."
python -m uvicorn app:app --host 127.0.0.1 --port $PORT --log-level warning &
SERVER_PID=$!

# 等待服务就绪（最多 10 秒）
echo -n "⏳ 等待服务启动"
for i in $(seq 1 20); do
  sleep 0.5
  if curl -s "http://127.0.0.1:$PORT" &>/dev/null; then
    break
  fi
  echo -n "."
done
echo ""

# 验证服务
if ! curl -s "http://127.0.0.1:$PORT" &>/dev/null; then
  echo "❌ 服务启动失败，请检查端口 $PORT 是否被占用"
  kill $SERVER_PID 2>/dev/null
  read -p "按回车键退出..."
  exit 1
fi

echo "✅ 服务已启动：http://127.0.0.1:$PORT"
echo ""
open "http://127.0.0.1:$PORT"

echo "============================================"
echo "  ⚠️  请勿关闭此窗口（关闭即停止服务）"
echo "============================================"
echo ""

# 捕获 Ctrl+C 优雅退出
trap "echo ''; echo '正在停止服务...'; kill $SERVER_PID 2>/dev/null; exit 0" INT TERM

wait $SERVER_PID
