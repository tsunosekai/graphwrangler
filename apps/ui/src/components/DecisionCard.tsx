import { useState } from "react";
import { api } from "../lib/api";
import { cn } from "../lib/utils";
import type { DecisionRequest, MaterializedMessage } from "../types";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

interface Props {
  message: MaterializedMessage;
  nodeId: string;
  onMutated: () => void;
}

// 聞き返し（ラリー）の入力は Thread 側の共通入力欄が担う（Claude Code と同じ構成）
export function DecisionCard({ message, nodeId, onMutated }: Props) {
  const [busy, setBusy] = useState(false);
  const payload = message.payload as { request: DecisionRequest } | null;
  const request = payload?.request;
  const open = message.requestStatus === "open";

  if (!request) return null;

  const choose = async (optionId: string) => {
    setBusy(true);
    try {
      await api.answer(nodeId, message.id, optionId);
      onMutated();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-lg border p-4 text-sm",
        open ? "border-ai bg-ai/[0.06]" : "border-border bg-card opacity-75",
      )}
    >
      <div className="whitespace-pre-wrap text-sm text-muted-foreground">{request.context}</div>
      <div className="font-semibold">{request.question}</div>
      <div className="flex flex-col gap-2">
        {request.options.map((opt) => (
          <Button
            key={opt.id}
            type="button"
            variant="outline"
            className={cn("h-auto flex-col items-start gap-1 whitespace-normal py-2 text-left", opt.recommended && "border-ai")}
            title={opt.then}
            disabled={!open || busy}
            onClick={() => choose(opt.id)}
          >
            <span className="flex items-center gap-2 font-semibold">
              {opt.label}
              {opt.recommended && (
                <Badge variant="outline" className="border-ai text-ai">
                  おすすめ
                </Badge>
              )}
            </span>
            <span className="text-sm font-normal text-muted-foreground">{opt.then}</span>
          </Button>
        ))}
      </div>
      <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
        <span>影響: {request.impact}</span>
        {request.undo && <span>取消: {request.undo}</span>}
        {!open && <span className="text-done">回答済み</span>}
      </div>
    </div>
  );
}
