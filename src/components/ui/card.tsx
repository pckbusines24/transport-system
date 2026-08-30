import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/**
 * The panel every surface in the app is built from.
 *
 * Variants describe the surface's ROLE, not its colour, so a screen can be
 * recomposed without hunting for hex values:
 *   plain     the default white panel
 *   inverted  the emphasis panel — one per screen at most, or it stops meaning
 *             anything
 *   sunken    a well: filters, empty states, anything that should read as
 *             carved into the page rather than sitting on it
 *   ghost     structure with no chrome, for grouping without adding a box
 */
const cardVariants = cva("min-w-0 rounded-xl transition-shadow duration-fast ease-out", {
  variants: {
    variant: {
      plain: "border border-border/70 bg-card text-card-foreground shadow-card",
      inverted: "bg-inverted text-inverted-foreground shadow-raised",
      sunken: "border border-border/60 bg-sunken text-sunken-foreground",
      ghost: "bg-transparent",
    },
    /** lift on hover — only for cards that are themselves a link or button */
    interactive: {
      true: "cursor-pointer hover:shadow-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
      false: "",
    },
  },
  defaultVariants: { variant: "plain", interactive: false },
});

export interface CardProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof cardVariants> {}

const Card = React.forwardRef<HTMLDivElement, CardProps>(
  ({ className, variant, interactive, ...props }, ref) => (
    <div ref={ref} className={cn(cardVariants({ variant, interactive }), className)} {...props} />
  )
);
Card.displayName = "Card";

const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("flex flex-col space-y-1.5 p-5 sm:p-6", className)}
      {...props}
    />
  )
);
CardHeader.displayName = "CardHeader";

/**
 * A header row with the title on the left and actions on the right — the
 * arrangement nearly every panel in the app wants, so it should not have to be
 * rebuilt with flex utilities on each screen.
 */
const CardToolbar = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("flex items-start justify-between gap-3 p-5 pb-0 sm:p-6 sm:pb-0", className)}
      {...props}
    />
  )
);
CardToolbar.displayName = "CardToolbar";

const CardTitle = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("text-lg font-medium leading-none tracking-[-0.01em]", className)}
      {...props}
    />
  )
);
CardTitle.displayName = "CardTitle";

const CardDescription = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("text-sm text-muted-foreground", className)} {...props} />
  )
);
CardDescription.displayName = "CardDescription";

const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div ref={ref} className={cn("p-5 pt-4 sm:p-6 sm:pt-4", className)} {...props} />
  )
);
CardContent.displayName = "CardContent";

const CardFooter = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      className={cn("flex items-center p-5 pt-0 sm:p-6 sm:pt-0", className)}
      {...props}
    />
  )
);
CardFooter.displayName = "CardFooter";

export {
  Card,
  CardHeader,
  CardToolbar,
  CardFooter,
  CardTitle,
  CardDescription,
  CardContent,
  cardVariants,
};
