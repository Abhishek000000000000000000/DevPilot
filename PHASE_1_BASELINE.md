# DevPilot — Phase 1 Baseline Architecture

## Overview
Phase 1 establishes the verified foundation of the DevPilot Visual Studio Code extension: extension lifecycle, command palette integration, static Webview UI matching the approved prototype, typed bidirectional communication bridge, and reproducible VSIX packaging.

---

## 1. Project Architecture

```
AIEngineeringAssistant/
├── package.json               # Extension manifest, commands, scripts, dependencies
├── tsconfig.json              # TypeScript configuration (Node16 module resolution)
├── eslint.config.mjs          # ESLint configuration
├── .vscodeignore              # Rules for VSIX packaging exclusion
├── media/                     # Webview frontend presentation assets
│   ├── css/
│   │   └── devpilot.css       # Dark-theme styling, glow effects, composer layout
│   └── js/
│       └── devpilot.js        # Webview client messaging, interaction & rendering logic
├── src/                       # Extension TypeScript source files
│   ├── extension.ts           # Extension entry point (`activate`, `deactivate`)
│   ├── panels/
│   │   └── DevPilotViewProvider.ts # Native WebviewView provider for sidebar integration
│   ├── types/
│   │   └── messages.ts        # Strongly typed UI <-> Extension message contracts
│   └── test/
│       └── extension.test.ts  # Integration test suite
└── out/                       # Compiled JavaScript output
```

---

## 2. Core Components

### 2.1 Extension Entry Point
- **File**: `src/extension.ts`
- **Activation Lifecycle**: Initializes `DevPilot` output channel, registers `DevPilotViewProvider` via `registerWebviewViewProvider`, and binds `devpilot.open` command to reveal and focus the sidebar view.
- **Deactivation Lifecycle**: Cleans up output channels and disposables cleanly.

### 2.2 VS Code Command
- **Command ID**: `devpilot.open`
- **Title**: `Open`
- **Category**: `DevPilot`
- **Palette Display**: `DevPilot: Open`
- **Behavior**: Focuses and reveals the `devpilot.view` in the native VS Code Sidebar / Auxiliary Bar without opening an editor tab.

### 2.3 WebviewView Provider
- **File**: `src/panels/DevPilotViewProvider.ts`
- **Architecture**: Implements `vscode.WebviewViewProvider` registered under `devpilot.view`.
- **Location**: Rendered in the VS Code Sidebar / Auxiliary Bar, ensuring code files continue opening exclusively in the central editor group.
- **Security**: Content Security Policy (CSP) with dynamic script nonces, strict local resource loading from `media/`.
- **UI Structure**:
  - Header: DevPilot brand logo, title, `PRO` badge, minimal action controls (`+`, `🕒`, `...`, `✕`).
  - Welcome State: Ambient glow aura, 3D gradient delta logo, greeting, and capability description.
  - Conversation View: Dynamic message container for user and assistant bubbles.
  - Composer: Bottom-anchored card with auto-expanding input, attachment button, and send button.

### 2.4 Communication Contract
- **File**: `src/types/messages.ts`
- **UI → Extension**:
  - `devpilot.ready`: Webview initialization handshake.
  - `devpilot.message`: User prompt payload `{ payload: { text: string } }`.
  - `devpilot.close`: Request to close the panel.
- **Extension → UI**:
  - `devpilot.ready`: Connection confirmation `{ payload: { status: 'connected', message: string } }`.
  - `devpilot.response`: Assistant response `{ payload: { text: string } }`.

---

## 3. Build & Packaging Specifications

- **Version**: `0.1.0`
- **Publisher**: `devpilot`
- **Compile Command**: `npm run compile`
- **Lint Command**: `npm run lint`
- **Test Command**: `npm run test`
- **Package Command**: `npm run package` (`vsce package --no-dependencies`)
- **Package Output**: `AIEngineeringAssistant-0.1.0.vsix`
- **Install Command**: `code --install-extension AIEngineeringAssistant-0.1.0.vsix --force`

---

## 4. Known Limitations (By Design in Phase 1)

1. **No AI Runtime**: Message responses are local placeholders proving communication connectivity. Real LLM / AI provider integrations begin in Phase 2.
2. **Session Volatility**: Conversation history is session-bound in memory and resets on panel reload. Persistence will be implemented in subsequent phases.
