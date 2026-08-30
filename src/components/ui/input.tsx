import * as React from "react";
import { cn } from "@/lib/utils";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement>;

/**
 * Fields sit on a sunken ground rather than carrying a heavy border: on the
 * warm canvas an outlined box reads as a cut-out, a filled one reads as a
 * place to type. The border only asserts itself on focus.
 */
const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => (
    <input
      type={type}
      className={cn(
        "flex h-10 w-full rounded-lg border border-border/70 bg-sunken px-3.5 py-2 text-sm",
        "transition-[border-color,box-shadow,background-color] duration-fast ease-out",
        "file:border-0 file:bg-transparent file:text-sm file:font-medium",
        "placeholder:text-muted-foreground/70",
        "hover:border-border",
        "focus-visible:border-ring/60 focus-visible:bg-card focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      ref={ref}
      {...props}
    />
  )
);
Input.displayName = "Input";

export { Input };
