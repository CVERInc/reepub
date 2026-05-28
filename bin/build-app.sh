#!/bin/bash
# Create a native macOS .app launcher for Reepub (Fully Dynamic)

# Resolve project directory at build time
PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="Reepub.app"
APP_PATH="$PROJECT_DIR/$APP_NAME"

echo "Building native macOS launcher in: $PROJECT_DIR"

TEMP_APP="/tmp/$APP_NAME"

# Clean old versions
if [ -d "$TEMP_APP" ]; then
  rm -rf "$TEMP_APP"
fi
if [ -d "$APP_PATH" ]; then
  rm -rf "$APP_PATH"
fi

# Compile AppleScript into a native macOS Application bundle in /tmp
# Note: Resolves project directory dynamically at runtime using 'path to me'
osacompile -o "$TEMP_APP" -e "
set app_path to POSIX path of (path to me)
set project_dir to (do shell script \"dirname \" & quoted form of app_path)

set port_check to (do shell script \"lsof -i :30232 -t || true\")
if port_check is not \"\" then
    display dialog \"Reepub 伺服器正在背景執行中。\" buttons {\"關閉伺服器\", \"開啟網頁\", \"取消\"} default button \"開啟網頁\" with title \"Reepub\"
    set user_choice to button returned of result
    if user_choice is \"關閉伺服器\" then
        do shell script \"kill -9 \$(lsof -i :30232 -t)\"
        display notification \"伺服器已成功關閉\" with title \"Reepub\"
    else if user_choice is \"開啟網頁\" then
        open location \"http://localhost:30232\"
    end if
else
    do shell script \"export PATH=\\\"/opt/homebrew/bin:/usr/local/bin:\$PATH\\\" && cd \" & quoted form of project_dir & \" && nohup npm start > /tmp/reepub-server-run.log 2>&1 &\"
    
    -- Poll until port 30232 is open
    set server_started to false
    repeat 10 times
        set port_check to (do shell script \"lsof -i :30232 -t || true\")
        if port_check is not \"\" then
            set server_started to true
            exit repeat
        end if
        delay 0.5
    end repeat
    
    if server_started then
        open location \"http://localhost:30232\"
        display notification \"伺服器已啟動並開啟瀏覽器！\" with title \"Reepub\"
    else
        display dialog \"伺服器啟動逾時。請確認專案環境，或檢查 /tmp/reepub-server-run.log 錯誤日誌。\" buttons {\"確定\"} default button \"確定\" with title \"Reepub 啟動錯誤\"
    end if
end if
"

# Remove quarantine attributes to prevent security errors
xattr -cr "$TEMP_APP" 2>/dev/null || true

# Move to target path
mv "$TEMP_APP" "$APP_PATH"

echo "Launcher application created successfully at: $APP_PATH"
