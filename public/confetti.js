// =============================================================================
// 紙吹雪（依存ライブラリなし・軽量）
// =============================================================================
const COLORS = ["#e21b3c", "#1368ce", "#e6a700", "#26890c", "#7b2ff7", "#ff2d87", "#ffd400"];

export function launchConfetti(count = 90) {
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const box = document.createElement("div");
  box.className = "confetti";
  for (let i = 0; i < count; i++) {
    const p = document.createElement("i");
    p.style.left = Math.random() * 100 + "%";
    p.style.background = COLORS[i % COLORS.length];
    p.style.animationDelay = (Math.random() * 0.4).toFixed(2) + "s";
    p.style.animationDuration = (1.8 + Math.random() * 1.4).toFixed(2) + "s";
    p.style.transform = `rotate(${Math.floor(Math.random() * 360)}deg)`;
    box.appendChild(p);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 3600);
}
