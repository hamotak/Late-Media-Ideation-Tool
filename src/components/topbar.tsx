"use client";

import { Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ChannelSwitcher } from "@/components/channel-switcher";
import { useTheme } from "@/lib/theme-provider";

export function Topbar() {
  const { theme, toggle } = useTheme();

  return (
    <header className="flex h-14 items-center justify-end gap-2 border-b border-border bg-background px-5">
      <ChannelSwitcher />
      <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle theme">
        {theme === "light" ? <Moon className="h-4 w-4" /> : <Sun className="h-4 w-4" />}
      </Button>
    </header>
  );
}
