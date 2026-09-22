import type { InputHTMLAttributes } from "react";
import { CHECKBOX_CLASS } from "./field";

export function Checkbox(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input type="checkbox" className={CHECKBOX_CLASS} {...props} />;
}
