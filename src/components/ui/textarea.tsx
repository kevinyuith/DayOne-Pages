import type { TextareaHTMLAttributes } from "react";
import { TEXTAREA_CLASS } from "./field";

export function Textarea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={TEXTAREA_CLASS} {...props} />;
}
