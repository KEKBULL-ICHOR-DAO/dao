import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./styles.css";
import "./styles.redesign.css";

const root = document.getElementById("root");
if (!root) {
  throw new Error("root element missing");
}

// Do not wrap this tree in React's development double-mount. This page talks
// to a browser-extension wallet. Each remount was another Phantom `connect`
// / contentscript stream. Measured 2026-08-24: MaxListenersExceededWarning
// then Brave ERR_INSUFFICIENT_RESOURCES.
createRoot(root).render(<App />);

