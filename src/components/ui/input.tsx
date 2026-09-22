import type { InputHTMLAttributes } from "react";
import { INPUT_CLASS } from "./field";

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={INPUT_CLASS} {...props} />;
}
