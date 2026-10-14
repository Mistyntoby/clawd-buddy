#!/bin/bash
# Clawd Buddy development launcher for macOS.
# Double-click in Finder to start Clawd Buddy from this folder (runs "npm start").
# It never installs anything globally, needs no administrator password, and
# only installs project dependencies after you confirm.
#
# First time only: macOS needs permission to run it. See docs/MACOS.md
# ("Run the launcher"): make it executable with
#   chmod +x Launch-ClawdBuddy.command
# then right-click it in Finder and choose Open.

# Always work in the folder this file lives in, wherever it was cloned.
cd "$(dirname "$0")" || { echo "Could not open the project folder."; read -r -p "Press Return to close." _; exit 1; }

pause_exit() {
  echo
  read -r -p "Press Return to close this window." _
  exit 1
}

# Apps started from Finder don't get your shell's PATH. Look in the usual Node.js locations.
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$HOME/.local/bin:$PATH"
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh"
  nvm use >/dev/null 2>&1 || true # picks the version in .nvmrc if it is installed
fi
if command -v fnm >/dev/null 2>&1; then
  eval "$(fnm env)"
  fnm use --silent-if-unchanged >/dev/null 2>&1 || true
fi

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js was not found."
  echo "Install Node.js 22 or newer (the LTS version is fine) from https://nodejs.org/ and run this launcher again."
  pause_exit
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "Clawd Buddy needs Node.js 22 or newer; this Mac has $(node --version)."
  echo "Install a newer version from https://nodejs.org/ and try again."
  pause_exit
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "npm was not found. It normally comes with Node.js; reinstall Node.js from https://nodejs.org/."
  pause_exit
fi

if [ ! -f node_modules/electron/package.json ]; then
  echo "Project dependencies are not installed yet."
  echo "This downloads the packages listed in package-lock.json from the npm registry into this folder."
  read -r -p "Install them now with 'npm ci'? [y/N] " answer
  case "$answer" in
    [yY]*) npm ci || { echo; echo "Installing dependencies failed. Check your internet connection and the messages above, then run 'npm ci' in this folder."; pause_exit; } ;;
    *) echo "Okay. You can install them later by running: npm ci"; pause_exit ;;
  esac
fi

# Electron downloads its runtime in an install step; repair it if that step was skipped.
if [ ! -d node_modules/electron/dist/Electron.app ]; then
  echo "Downloading the Electron runtime..."
  node node_modules/electron/install.js || { echo "Downloading Electron failed."; pause_exit; }
fi

echo "Starting Clawd Buddy... (close this window or press Ctrl+C to stop it)"
if ! npm start; then
  echo
  echo "Clawd Buddy stopped with an error. The messages above explain what went wrong."
  pause_exit
fi
