const TOAST_STYLES = `
  @keyframes mmToastIn {
    from { opacity: 0; transform: translateY(6px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  @keyframes mmToastOut {
    from { opacity: 1; transform: translateY(0); }
    to   { opacity: 0; transform: translateY(4px); }
  }
`

export function showSaveToast(): void {
  document.getElementById("memorymesh-toast")?.remove()

  const toast = document.createElement("div")
  toast.id = "memorymesh-toast"
  toast.style.cssText = `
    position: fixed;
    bottom: 20px;
    right: 20px;
    z-index: 99998;
    background: #13132a;
    border: 1px solid rgba(124, 106, 247, 0.3);
    border-radius: 8px;
    padding: 7px 13px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 12px;
    color: #a78bfa;
    display: flex;
    align-items: center;
    gap: 6px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.45);
    pointer-events: none;
    animation: mmToastIn 0.18s ease-out;
  `
  const styleEl = document.createElement("style")
  styleEl.textContent = TOAST_STYLES
  const checkEl = document.createElement("span")
  checkEl.style.fontSize = "11px"
  checkEl.textContent = "✓"
  const labelEl = document.createElement("span")
  labelEl.textContent = "Memory saved"
  toast.appendChild(styleEl)
  toast.appendChild(checkEl)
  toast.appendChild(labelEl)

  document.body.appendChild(toast)

  setTimeout(() => {
    toast.style.animation = "mmToastOut 0.25s ease-out forwards"
    setTimeout(() => toast.remove(), 250)
  }, 2000)
}
