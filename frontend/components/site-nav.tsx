import Link from "next/link";
import { Shield, Github } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function SiteNav() {
  return (
    <nav className="fixed top-6 left-1/2 -translate-x-1/2 z-50 w-[95%] max-w-7xl rounded-full bg-black/50 backdrop-blur-xl border border-white/10 px-6 h-16 flex items-center justify-between transition-all duration-300">
      <div className="flex items-center gap-3">
        <Link href="/" className="flex items-center gap-2 group">
          <Shield className="w-6 h-6 text-primary transition-transform group-hover:rotate-12" />
          <span className="text-lg font-bold text-white tracking-wide">
            SENTINEL
          </span>
        </Link>
      </div>

      <div className="hidden md:flex items-center gap-8">
        {[
          { name: "Features", href: "/#features" },
          { name: "How It Works", href: "/#how-it-works" },
          { name: "Security", href: "/#security" },
          { name: "Docs", href: "/docs" },
        ].map((item) => (
          <Link
            key={item.name}
            href={item.href}
            className="text-sm font-medium text-gray-400 hover:text-primary transition-colors relative group"
          >
            {item.name}
            <span className="absolute -bottom-1 left-0 w-0 h-0.5 bg-primary transition-all group-hover:w-full" />
          </Link>
        ))}
      </div>

      <div className="flex items-center gap-4">
        <Link
          href="https://github.com"
          target="_blank"
          rel="noopener noreferrer"
          className="text-gray-400 hover:text-white transition-colors"
        >
          <Github className="w-5 h-5" />
        </Link>
        <Link href="/launch">
          <Button
            size="sm"
            className="bg-white text-black hover:bg-gray-200 rounded-full px-6 font-medium transition-transform hover:scale-105"
          >
            Launch App
          </Button>
        </Link>
      </div>
    </nav>
  );
}
