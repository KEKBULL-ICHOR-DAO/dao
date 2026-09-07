import { useEffect, useRef, type ReactNode } from "react";

/**
 * Holder-page work section. Closed on first paint so the one-pager is a
 * labeled index, not a full scroll of every panel. A matching URL hash
 * (`#burn`, `#vote`, …) opens that section - masthead links keep working.
 */
export function HolderSection(props: {
  readonly id: string;
  readonly idx: string;
  readonly group?: string;
  readonly kicker: string;
  readonly note?: string;
  readonly token?: "kek" | "ichor";
  readonly children: ReactNode;
}) {
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    const sync = (): void => {
      if (!ref.current) {
        return;
      }
      if (window.location.hash === `#${props.id}`) {
        ref.current.open = true;
      }
    };
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, [props.id]);

  const mark =
    props.token === "kek"
      ? { src: "/logo.png", className: "kek", alt: "KEKBULL" }
      : props.token === "ichor"
        ? { src: "/ichor-mark.png", className: "", alt: "ICHOR" }
        : null;

  return (
    <details ref={ref} className="section section-fold" id={props.id}>
      <summary>
        <div className="section-rule" aria-hidden="true">
          <span className="idx">{props.idx}</span>
          {props.group ? <span className="group">{props.group}</span> : null}
        </div>
        <div className="section-fold-title">
          <div className="section-mark">
            {mark ? <img src={mark.src} className={mark.className} alt="" width={30} height={30} /> : null}
            <h2>{props.kicker}</h2>
          </div>
        </div>
        {props.note ? <p className="lede">{props.note}</p> : null}
      </summary>
      {props.children}
    </details>
  );
}
