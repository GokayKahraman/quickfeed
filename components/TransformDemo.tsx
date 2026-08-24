"use client";

import { useEffect, useState } from "react";
import { highlightLine } from "./highlight";

const COMPACT = `<product><id>3213</id><name>Leather Jacket</name><price currency="TRY">2499.90</price><stock>14</stock></product>`;

const FORMATTED = [
  "<product>",
  "    <id>3213</id>",
  "    <name>Leather Jacket</name>",
  '    <price currency="TRY">2499.90</price>',
  "    <stock>14</stock>",
  "</product>",
];

function Line({ text, delay }: { text: string; delay: number }) {
  return (
    <div className="demo-line" style={{ animationDelay: `${delay}ms` }}>
      {highlightLine(text).map((s, i) => (
        <span className={s.c} key={i}>
          {s.t}
        </span>
      ))}
    </div>
  );
}

/**
 * The thesis of the tool, in six lines: one unreadable line of feed becomes
 * one record you can actually scan. It runs once on arrival and can be
 * replayed, and it uses the same highlighter as the real viewer.
 */
export default function TransformDemo() {
  const [open, setOpen] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    setOpen(false);
    const t = setTimeout(() => setOpen(true), 1100);
    return () => clearTimeout(t);
  }, [nonce]);

  return (
    <div className="demo">
      <div className="demo-head">
        <span className="dot" />
        {open ? "after — indented, line by line" : "before — one line, 1 record"}
      </div>
      <div className="demo-body">
        {open ? (
          FORMATTED.map((line, i) => <Line key={`f${nonce}-${i}`} text={line} delay={i * 55} />)
        ) : (
          <Line key={`c${nonce}`} text={COMPACT} delay={0} />
        )}
      </div>
      <div className="demo-foot">
        <span>Indentation and line breaks are added; the content is untouched.</span>
        <button type="button" onClick={() => setNonce((n) => n + 1)}>
          replay
        </button>
      </div>
    </div>
  );
}
