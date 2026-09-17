export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh items-start justify-center px-4 py-16 sm:items-center">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-6 shadow-sm">{children}</div>
    </div>
  );
}
