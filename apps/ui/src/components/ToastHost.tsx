import { useEffect, useState } from "react";
import { subscribeToast } from "../lib/toast";

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
    <div className="toast-host">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
