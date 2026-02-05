"use client";
import { ReactNode } from "react";
import Link from "next/link";
import { ChevronRight, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

interface DocLayoutProps {
  children: ReactNode;
  title: string;
  description: string;
  category: string;
  previousPage?: { href: string; title: string };
  nextPage?: { href: string; title: string };
}

export default function DocLayout({
  children,
  title,
  description,
  category,
  previousPage,
  nextPage,
}: DocLayoutProps) {
  return (
    <div className="min-h-screen bg-[#0a0a0f] text-gray-200">
      <div className="max-w-5xl mx-auto px-6 lg:px-12 py-12">
        {/* Breadcrumb */}
        <div className="flex items-center gap-2 text-sm text-gray-500 mb-8">
          <Link href="/" className="hover:text-primary transition-colors">
            Home
          </Link>
          <ChevronRight className="w-4 h-4" />
          <Link href="/docs" className="hover:text-primary transition-colors">
            Documentation
          </Link>
          <ChevronRight className="w-4 h-4" />
          <span className="text-gray-400">{category}</span>
        </div>

        {/* Back to docs */}
        <Link
          href="/docs"
          className="inline-flex items-center gap-2 text-sm text-gray-400 hover:text-primary transition-colors mb-8 group"
        >
          <ArrowLeft className="w-4 h-4 group-hover:-translate-x-1 transition-transform" />
          Back to Documentation
        </Link>

        {/* Header */}
        <header className="mb-12 pb-8 border-b border-gray-800/60">
          <h1 className="text-5xl font-bold mb-4 text-white tracking-tight">
            {title}
          </h1>
          <p className="text-2xl text-gray-400 leading-relaxed max-w-3xl">
            {description}
          </p>
        </header>

        {/* Content */}
        <article className="prose prose-invert prose-lg max-w-none prose-headings:font-bold prose-headings:tracking-tight prose-h2:text-3xl prose-h2:text-white prose-h2:mt-12 prose-h2:mb-6 prose-h3:text-2xl prose-h3:text-gray-100 prose-h3:mt-8 prose-h3:mb-4 prose-p:text-gray-300 prose-p:leading-relaxed prose-a:text-primary prose-a:no-underline hover:prose-a:underline prose-code:text-primary prose-code:bg-gray-900/50 prose-code:px-2 prose-code:py-1 prose-code:rounded prose-pre:bg-gray-900/80 prose-pre:border prose-pre:border-gray-800/60 prose-li:text-gray-300">
          {children}
        </article>

        {/* Navigation */}
        <nav className="flex items-center justify-between mt-16 pt-8 border-t border-gray-800/60 gap-4">
          {previousPage ? (
            <Link
              href={previousPage.href}
              className="flex-1 group hover:border-primary/50 transition-colors"
            >
              <Button
                variant="outline"
                className="p-6 rounded-xl border border-gray-800/60 bg-gray-900/40 hover:border-primary/50 transition-colors"
              >
                <ArrowLeft className="w-4 h-4 mr-2 group-hover:-translate-x-1 transition-transform" />
                <div className="text-left">
                  <div className="text-xs text-gray-500 mb-1">Previous</div>
                  <div className="text-sm font-medium">
                    {previousPage.title}
                  </div>
                </div>
              </Button>
            </Link>
          ) : (
            <div className="flex-1" />
          )}

          {nextPage ? (
            <Link
              href={nextPage.href}
              className="flex-1 group hover:border-primary/50 transition-colors"
            >
              <Button
                variant="outline"
                className="p-6 rounded-xl border border-gray-800/60 bg-gray-900/40 hover:border-primary/50 transition-colors"
              >
                <div className="text-right">
                  <div className="text-xs text-gray-500 mb-1">Next</div>
                  <div className="text-sm font-medium">{nextPage.title}</div>
                </div>
                <ChevronRight className="w-4 h-4 ml-2 group-hover:translate-x-1 transition-transform" />
              </Button>
            </Link>
          ) : (
            <div className="flex-1" />
          )}
        </nav>
      </div>
    </div>
  );
}
