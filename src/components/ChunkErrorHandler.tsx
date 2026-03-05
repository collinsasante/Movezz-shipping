"use client";

import { useEffect } from "react";

export default function ChunkErrorHandler() {
  useEffect(() => {
    const handle = (event: ErrorEvent) => {
      const err = event.error;
      const isChunkError =
        err?.name === "ChunkLoadError" ||
        err?.code === "CSS_CHUNK_LOAD_FAILED" ||
        (typeof err?.message === "string" && err.message.includes("Failed to load chunk"));

      if (isChunkError) {
        const key = "__chunk_reload";
        if (!sessionStorage.getItem(key)) {
          sessionStorage.setItem(key, "1");
          window.location.reload();
        }
      }
    };

    window.addEventListener("error", handle);
    return () => window.removeEventListener("error", handle);
  }, []);

  return null;
}
