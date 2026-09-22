import type { SelectHTMLAttributes, ReactNode } from "react";
import { SELECT_CLASS } from "./field";

export function Select({
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { children?: ReactNode }) {
  return (
    <select className={SELECT_CLASS} {...props}>
      {children}
    </select>
  );
}
