"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { desktop } from "@/lib/desktop/client";

/** Home's search field listens for this to take focus. */
export const FOCUS_SEARCH = "mlch:focus-search";

/**
 * ⌘K (and the menu's Search) from any screen: in a mulch its own palette
 * opens (SearchPalette), on home the search field takes focus, anywhere else
 * home opens with the field ready.
 */
export function SearchKey() {
  const router = useRouter();
  const pathname = usePathname();
  useEffect(() => {
    const search = (fromMenu: boolean) => {
      if (pathname.startsWith("/n/")) {
        // The palette listens for the key itself; a menu click is passed on as the key.
        if (fromMenu) window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }));
        return;
      }
      if (pathname === "/") window.dispatchEvent(new Event(FOCUS_SEARCH));
      else router.push("/?search=1");
    };
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k" && !pathname.startsWith("/n/")) {
        event.preventDefault();
        search(false);
      }
    };
    window.addEventListener("keydown", onKey);
    const off = desktop()?.onMenu?.((command) => command === "search" && search(true));
    return () => {
      window.removeEventListener("keydown", onKey);
      off?.();
    };
  }, [pathname, router]);
  return null;
}
