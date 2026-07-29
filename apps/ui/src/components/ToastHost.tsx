import { useEffect, useState } from "react";
import { subscribeToast } from "../lib/toast";
import { cn } from "../lib/utils";

interface ToastItem {
  id: number;
  message: string;
  kind: "error" | "info";
}

let counter = 0;

export function ToastHost() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => {
    return subscribeToast((message, kind) => {
      const id = ++counter;
      setToasts((t) => [...t, { id, message, kind }]);
      window.setTimeout(() => {
        setToasts((t) => t.filter((x) => x.id !== id));
      }, 5000);
    });
  }, []);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed left-1/2 top-3 z-[1000] flex -translate-x-1/2 flex-col gap-1.5">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            "rounded-md border bg-card px-3.5 py-2 text-sm text-foreground shadow-lg",
            t.kind === "error" ? "border-destructive" : "border-ai/50",
          )}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
}
