/**
 * Monograma F' do Fields' — os mesmos traços do LogoIcon do App.jsx, agora em currentColor, sem
 * gradiente nem brilho. A cor vem de quem usa (ex.: `style={{ color: "var(--accent)" }}`).
 * Decorativo por padrão; com `title`, vira role="img" com nome acessível.
 */
export function Logo({ size = 20, title, className, ...rest }) {
  const acessivel = title ? { role: "img", "aria-label": title } : { "aria-hidden": "true" };
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      fill="currentColor"
      focusable="false"
      className={className}
      {...acessivel}
      {...rest}
    >
      {/* F — bloco sólido */}
      <path d="M8 5 L24.5 5 L24.5 9.5 L13 9.5 L13 14 L20.5 14 L20.5 18.5 L13 18.5 L13 27 L8 27 Z" />
      {/* Apóstrofo — acento anguloso */}
      <path d="M26.5 4 L29.5 4 L27.3 11.5 L25.3 11.5 Z" />
    </svg>
  );
}
