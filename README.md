# DevPilot (AI Engineering Assistant)

DevPilot is a native, premium AI development assistant extension for Visual Studio Code designed to assist developers with analyzing, building, testing, and reviewing code in their workspace.

## Features

- **Native Assistant Panel**: Dedicated, non-intrusive assistant panel that integrates seamlessly with your editor layout.
- **Interactive UI**: Sleek dark-mode interface featuring dynamic input composer and status indicators.
- **Command Palette Integration**: Launch instantly using `DevPilot: Open` (`devpilot.open`).
- **Bidirectional Communication Bridge**: Robust typed messaging contract between the Webview UI and VS Code Extension Host.

## Getting Started

1. Open Visual Studio Code.
2. Open the Command Palette (`Ctrl+Shift+P` on Windows/Linux, `Cmd+Shift+P` on macOS).
3. Type and select `DevPilot: Open`.
4. The DevPilot assistant panel will open beside your active editor.

## Extension Commands

- `devpilot.open`: Opens or reveals the DevPilot assistant panel.

## Requirements

- Visual Studio Code version `^1.140.0` or higher.

## Release Notes

### 0.1.0

- Extension Foundation & Activation lifecycle.
- Official `DevPilot: Open` command registration.
- Static DevPilot UI implementation with responsive layout and dark theme.
- Webview <-> Extension Host communication bridge.
