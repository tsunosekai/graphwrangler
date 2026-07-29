// shadcn/ui の標準ヘルパー。clsx + tailwind-merge でクラス名を合成する。
import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
