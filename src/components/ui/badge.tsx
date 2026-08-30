import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * Status pill. Tones are semantic — a badge should say what a thing IS, never
 * pick a colour directly, so PAID reads the same green on every screen.
 *
 * Soft tinted fills rather than saturated blocks: a register can show forty of
 * these at once and solid colour would turn the table into a traffic light.
 */
const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground",
        ink: "bg-inverted text-inverted-foreground",
        secondary: "bg-secondary text-secondary-foreground",
        outline: "border border-border text-foreground",
        muted: "bg-muted text-muted-foreground",
        success: "bg-success/12 text-success",
        warning: "bg-warning/15 text-warning",
        info: "bg-info/12 text-info",
        destructive: "bg-destructive/12 text-destructive",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {
  /** leading status dot — reinforces the tone for anyone who cannot see it */
  dot?: boolean;
}

function Badge({ className, variant, dot, children, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props}>
      {dot && <span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden />}
      {children}
    </div>
  );
}

export { Badge, badgeVariants };
