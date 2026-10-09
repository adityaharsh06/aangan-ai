"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BookOpenCheck, Gauge, PhoneCall, ListChecks } from "lucide-react";
import { cn } from "./ui";

const ITEMS = [
  { href: "/", label: "Dashboard", icon: Gauge },
  { href: "/enquiries", label: "Enquiries", icon: ListChecks },
  { href: "/simulator", label: "Call simulator", icon: PhoneCall },
  { href: "/rules", label: "Rules & sources", icon: BookOpenCheck },
];

export function Nav() {
  const path = usePathname();
  return (
    <aside className="flex shrink-0 flex-col border-line bg-night text-white md:h-screen md:w-60 md:border-r">
      <div className="flex items-center gap-3 px-5 py-5">
        <div className="flex size-9 items-center justify-center rounded-lg bg-brand font-display">आ</div>
        <div>
          <p className="text-sm font-semibold">Aangan AI</p>
          <p className="text-[11px] text-white/50">Phone enquiries</p>
        </div>
      </div>
      <nav className="flex gap-1 overflow-x-auto px-3 pb-3 md:flex-col md:pb-0">
        {ITEMS.map(({ href, label, icon: Icon }) => {
          const active = href === "/" ? path === "/" : path.startsWith(href);
          return (
            <Link key={href} href={href} className={cn("flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm whitespace-nowrap", active ? "bg-white/10 text-white" : "text-white/60 hover:bg-white/5 hover:text-white")}>
              <Icon className="size-4" />
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto hidden border-t border-white/10 p-4 md:block">
        <p className="text-xs text-white/50">Assessment build · no login</p>
        <p className="mt-1 text-[11px] text-white/35">MESA AI &amp; Its Applications · Case 03</p>
      </div>
    </aside>
  );
}
