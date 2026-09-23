"use client";

import type { ComponentProps } from "react";
import { cn } from "@/components/lib/utils.js";

export type MarkdownBlockquoteProps = ComponentProps<"blockquote"> & {
  node?: unknown;
};

export function MarkdownBlockquote({ className, node: _node, ...props }: MarkdownBlockquoteProps) {
  return (
    // // dir="auto" + logical border-s/ps: RTL blockquote bar and indent flip to the right; LTR rendering is unchanged.
    <blockquote
      className={cn(
        "my-4 border-border border-s-2 ps-3 text-foreground-subtle",
        "[&_p]:my-0 [&_p+p]:mt-2",
        className,
      )}
      dir="auto"
      data-markdown-blockquote=""
      {...props}
    />
  );
}
