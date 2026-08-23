import { useEffect, useState } from "react";

export function PageLoader() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setVisible(true), 150);
    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm transition-opacity duration-300">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 rounded-full border-3 border-primary/30 border-t-primary animate-spin" />
      </div>
    </div>
  );
}
