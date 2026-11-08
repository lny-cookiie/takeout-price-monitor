@echo off
chcp 65001 >nul
cd /d "%~dp0"
set "TAKEOUT_MODEL_DIR=.runtime\local-model-lab"
if not exist "%TAKEOUT_MODEL_DIR%\vulkan\llama-server.exe" goto missing
if not exist "%TAKEOUT_MODEL_DIR%\Qwen3-VL-2B-Instruct-Q8_0.gguf" goto missing
if not exist "%TAKEOUT_MODEL_DIR%\mmproj-Qwen3-VL-2B-Instruct-Q8_0.gguf" goto missing
if not exist "%TAKEOUT_MODEL_DIR%\api-key" goto missing
echo 本机模型地址：http://127.0.0.1:11436/v1
echo 模型首次加载约需几十秒。
"%TAKEOUT_MODEL_DIR%\vulkan\llama-server.exe" -m "%TAKEOUT_MODEL_DIR%\Qwen3-VL-2B-Instruct-Q8_0.gguf" --mmproj "%TAKEOUT_MODEL_DIR%\mmproj-Qwen3-VL-2B-Instruct-Q8_0.gguf" --host 127.0.0.1 --port 11436 --alias qwen3-vl-2b-local --ctx-size 16384 --n-gpu-layers 99 --parallel 2 --api-key-file "%TAKEOUT_MODEL_DIR%\api-key" --no-ui
exit /b %errorlevel%
:missing
echo 本机验证模型文件不齐，请按 README 配置可用的模型服务。
exit /b 1