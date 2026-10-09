import { Nav } from "@/components/nav";

export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <Nav />
      <main className="min-w-0 flex-1 md:h-screen md:overflow-y-auto">
        <div className="mx-auto max-w-7xl px-4 py-6 md:px-8 md:py-8">{children}</div>
      </main>
    </div>
  );
}
