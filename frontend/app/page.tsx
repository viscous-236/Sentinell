"use client";

import { Button } from "@/components/ui/button";
import { ArrowRight, Shield, Zap, Lock, Eye, Play, ArrowUpRight } from "lucide-react";
import Link from "next/link";

// Animated Orbital Ring Component
function OrbitalRing({ 
  size, 
  duration, 
  reverse = false, 
  dotPositions = [0, 90, 180, 270] 
}: { 
  size: number; 
  duration: number; 
  reverse?: boolean; 
  dotPositions?: number[];
}) {
  return (
    <div 
      className={`absolute rounded-full border border-white/10 ${reverse ? 'animate-orbit-reverse' : 'animate-orbit'}`}
      style={{ 
        width: `${size}px`, 
        height: `${size}px`,
        animationDuration: `${duration}s`,
        left: '50%',
        top: '50%',
        transform: 'translate(-50%, -50%)'
      }}
    >
      {dotPositions.map((angle, idx) => (
        <div
          key={idx}
          className="absolute w-2 h-2 bg-primary rounded-full animate-dot-pulse"
          style={{
            left: '50%',
            top: '0%',
            transform: `rotate(${angle}deg) translateY(-50%) translateX(-50%)`,
            transformOrigin: `0 ${size/2}px`,
            animationDelay: `${idx * 0.5}s`
          }}
        />
      ))}
    </div>
  );
}

// Animated Glowing Sphere Component
function GlowingSphere() {
  return (
    <div className="relative w-[400px] h-[400px] md:w-[500px] md:h-[500px] mx-auto">
      {/* Orbital rings */}
      <OrbitalRing size={600} duration={40} dotPositions={[45, 225]} />
      <OrbitalRing size={520} duration={35} reverse dotPositions={[0, 120, 240]} />
      <OrbitalRing size={440} duration={30} dotPositions={[90, 270]} />
      
      {/* Main sphere */}
      <div 
        className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[350px] h-[350px] md:w-[420px] md:h-[420px] rounded-full animate-sphere-glow"
        style={{
          background: `
            radial-gradient(circle at 30% 30%, 
              hsl(var(--primary)) 0%, 
              hsl(var(--accent)) 40%, 
              hsl(var(--secondary)) 70%, 
              #0a1a2a 100%
            )
          `,
        }}
      >
        {/* Text overlay on sphere */}
        <div className="absolute inset-0 flex flex-col items-center justify-center text-center px-8">
          <span className="text-xs text-white/60 mb-2 tracking-widest">{ `{ 01 }` }</span>
          <p className="text-lg md:text-xl text-white font-light leading-relaxed">
            You turn your liquidity
            <br />
            into security.
          </p>
        </div>
      </div>
      
      {/* Second text element below sphere */}
      <div className="absolute bottom-[-60px] left-1/2 -translate-x-1/2 text-center">
        <span className="text-xs text-white/40 mb-2 tracking-widest block">{ `{ 02 }` }</span>
        <p className="text-base text-white/60 font-light">
          You contribute
          <br />
          to DeFi safety.
        </p>
      </div>
    </div>
  );
}

// Feature Icon Component
function FeatureIcon({ 
  icon: Icon, 
  label, 
  shape = "circle" 
}: { 
  icon: React.ElementType; 
  label: string; 
  shape?: "circle" | "square" | "triangle";
}) {
  const shapeClasses = {
    circle: "rounded-full",
    square: "rounded-lg",
    triangle: "rounded-lg rotate-45"
  };
  
  return (
    <div className="flex flex-col items-center gap-3 group">
      <div className={`w-12 h-12 bg-primary/20 border border-primary/40 ${shapeClasses[shape]} flex items-center justify-center transition-all group-hover:bg-primary/40 group-hover:scale-110`}>
        <Icon className={`w-5 h-5 text-primary ${shape === 'triangle' ? '-rotate-45' : ''}`} />
      </div>
      <span className="text-sm text-gray-700 font-medium">{label}</span>
    </div>
  );
}

export default function Home() {
  return (
    <div className="min-h-screen bg-background text-foreground overflow-hidden">
      {/* Section 1: Hero with Glowing Sphere - Dark Background */}
      <section className="relative min-h-screen bg-[#0a0a0a] overflow-hidden">
        {/* Dynamic Background Particles */}
        <div className="absolute inset-0 overflow-hidden">
          {[...Array(20)].map((_, i) => (
            <div
              key={i}
              className="absolute w-1 h-1 bg-primary/40 rounded-full animate-float-particle"
              style={{
                left: `${Math.random() * 100}%`,
                top: `${Math.random() * 100}%`,
                animationDelay: `${Math.random() * 5}s`,
                animationDuration: `${6 + Math.random() * 4}s`
              }}
            />
          ))}
        </div>
        
        {/* Gradient glow effects */}
        <div className="absolute top-0 left-1/4 w-96 h-96 bg-primary/10 rounded-full blur-[150px]" />
        <div className="absolute bottom-0 right-1/4 w-96 h-96 bg-accent/10 rounded-full blur-[150px]" />
        
        {/* Content */}
        <div className="relative z-10 px-6 md:px-12 py-32 md:py-40">
          <div className="max-w-4xl mx-auto text-center">
            <span className="inline-block text-xs tracking-[0.3em] text-white/50 mb-6">
              { `{ THE RESULT? }` }
            </span>
            
            <h1 className="text-4xl md:text-6xl lg:text-7xl font-light mb-6 leading-tight racing-sans-one-regular">
              <span className="text-white">Are You A DeFi </span>
              <span className="text-primary">Leader</span>
              <br />
              <span className="text-white">Seeking Security?</span>
            </h1>
            
            <p className="text-gray-400 text-lg max-w-xl mx-auto">
              At Sentinel, our purpose is to help you protect your liquidity.
            </p>
          </div>
          
          {/* Glowing Sphere with Orbits */}
          <div className="relative h-[600px] md:h-[700px] flex items-center justify-center">
            <GlowingSphere />
          </div>
        </div>
      </section>

      {/* Section 2: AI Platform - Light Background */}
      <section className="relative bg-[#f5f5f5] py-20 md:py-32 overflow-hidden">
        {/* Subtle decorative elements */}
        <div className="absolute top-10 left-10 w-3 h-3 bg-primary/30 rounded-full animate-pulse-glow" />
        <div className="absolute bottom-20 right-20 w-2 h-2 bg-primary/20 rounded-full animate-pulse-glow" style={{ animationDelay: '1s' }} />
        
        <div className="max-w-6xl mx-auto px-6 md:px-12">
          <div className="text-center mb-12">
            <span className="inline-block text-xs tracking-[0.3em] text-gray-500 mb-4">
              { `{ OUR AI PRODUCTS }` }
            </span>
            
            <h2 className="text-3xl md:text-5xl lg:text-6xl font-light mb-4 racing-sans-one-regular">
              <span className="text-primary">Agent-Powered</span>
              <span className="text-gray-900"> Security Platform</span>
            </h2>
            
            <p className="text-gray-500 max-w-2xl mx-auto">
              Sentinel is Revolutionizing DeFi Security: We detect the previously undetectable.
            </p>
          </div>
          
          {/* Video Player Mockup */}
          <div className="relative max-w-4xl mx-auto mb-16">
            <div className="aspect-video bg-[#0a0a0a] rounded-2xl overflow-hidden border border-gray-200 shadow-2xl">
              {/* Geometric pattern background */}
              <div className="absolute inset-0 opacity-20">
                <svg className="w-full h-full" viewBox="0 0 400 300">
                  <pattern id="hexPattern" patternUnits="userSpaceOnUse" width="30" height="26">
                    <polygon 
                      points="15,0 30,7.5 30,22.5 15,30 0,22.5 0,7.5" 
                      fill="none" 
                      stroke="currentColor" 
                      strokeWidth="0.5"
                      className="text-primary"
                    />
                  </pattern>
                  <rect width="100%" height="100%" fill="url(#hexPattern)" />
                </svg>
              </div>
              
              {/* Play button */}
              <div className="absolute inset-0 flex items-center justify-center">
                <button className="w-16 h-16 bg-primary rounded-full flex items-center justify-center shadow-lg shadow-primary/50 hover:scale-110 transition-transform">
                  <Play className="w-6 h-6 text-white ml-1" fill="white" />
                </button>
              </div>
            </div>
          </div>
          
          {/* Feature Icons Grid */}
          <div className="grid grid-cols-3 md:grid-cols-6 gap-8 max-w-4xl mx-auto">
            <FeatureIcon icon={Eye} label="Scout Agent" shape="circle" />
            <FeatureIcon icon={Shield} label="Validator Agent" shape="square" />
            <FeatureIcon icon={Zap} label="Risk Engine" shape="triangle" />
            <FeatureIcon icon={Lock} label="TEE Security" shape="circle" />
            <FeatureIcon icon={Shield} label="Multi-Chain" shape="square" />
            <FeatureIcon icon={Zap} label="Real-time" shape="triangle" />
          </div>
        </div>
      </section>

      {/* Section 3: CTA - Dark Background with Glow */}
      <section className="relative bg-[#0a0a0a] py-20 md:py-32 overflow-hidden">
        {/* Orange/Cyan glow in bottom right */}
        <div 
          className="absolute bottom-0 right-0 w-[600px] h-[600px] rounded-full blur-[200px] animate-pulse-glow"
          style={{
            background: 'radial-gradient(circle, hsl(var(--primary)) 0%, transparent 70%)'
          }}
        />
        
        {/* Orbital decoration */}
        <div className="absolute left-10 top-1/2 -translate-y-1/2 w-[300px] h-[300px] opacity-30">
          <OrbitalRing size={300} duration={50} dotPositions={[0, 90, 180]} />
        </div>
        
        <div className="relative z-10 max-w-4xl mx-auto px-6 md:px-12 text-center">
          <span className="inline-block text-xs tracking-[0.3em] text-white/50 mb-6">
            { `{ INTERESTED? }` }
          </span>
          
          <h2 className="text-3xl md:text-5xl lg:text-6xl font-light mb-6 racing-sans-one-regular">
            <span className="text-white">Are you ready to be </span>
            <span className="text-primary italic">protected</span>
            <span className="text-white">?</span>
          </h2>
          
          <p className="text-gray-400 mb-10">
            Get started with Sentinel and we'll secure your liquidity.
          </p>
          
          {/* CTA Button */}
          <Link href="/docs">
            <Button 
              size="lg" 
              className="bg-transparent border border-white/20 hover:border-primary hover:bg-primary/10 text-white px-8 py-6 text-lg rounded-full transition-all group"
            >
              <span className="w-10 h-10 bg-primary rounded-full flex items-center justify-center mr-4 group-hover:scale-110 transition-transform">
                <ArrowUpRight className="w-5 h-5 text-white" />
              </span>
              Start Protecting
            </Button>
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-[#0a0a0a] border-t border-white/10 pt-16 pb-8 px-6 md:px-12">
        <div className="max-w-6xl mx-auto">
          {/* Footer Links Grid */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-8 mb-12">
            <div>
              <h4 className="text-xs tracking-widest text-primary mb-4 uppercase">Product</h4>
              <ul className="space-y-3 text-sm text-gray-400">
                <li><a href="#" className="hover:text-white transition-colors">Features</a></li>
                <li><a href="#" className="hover:text-white transition-colors">Security</a></li>
                <li><a href="#" className="hover:text-white transition-colors">Pricing</a></li>
                <li><a href="#" className="hover:text-white transition-colors">Enterprise</a></li>
              </ul>
            </div>
            <div>
              <h4 className="text-xs tracking-widest text-primary mb-4 uppercase">Support</h4>
              <ul className="space-y-3 text-sm text-gray-400">
                <li><a href="#" className="hover:text-white transition-colors">Support</a></li>
                <li><a href="#" className="hover:text-white transition-colors">Community</a></li>
                <li><a href="#" className="hover:text-white transition-colors">Help Docs</a></li>
                <li><a href="#" className="hover:text-white transition-colors">Partner Portal</a></li>
              </ul>
            </div>
            <div>
              <h4 className="text-xs tracking-widest text-primary mb-4 uppercase">Resources</h4>
              <ul className="space-y-3 text-sm text-gray-400">
                <li><a href="/docs" className="hover:text-white transition-colors">Documentation</a></li>
                <li><a href="#" className="hover:text-white transition-colors">API Reference</a></li>
                <li><a href="#" className="hover:text-white transition-colors">Blog</a></li>
                <li><a href="#" className="hover:text-white transition-colors">Changelog</a></li>
              </ul>
            </div>
            <div>
              <h4 className="text-xs tracking-widest text-primary mb-4 uppercase">Account</h4>
              <ul className="space-y-3 text-sm text-gray-400">
                <li><a href="#" className="hover:text-white transition-colors">Login</a></li>
                <li><a href="#" className="hover:text-white transition-colors">Get Started</a></li>
                <li><a href="#" className="hover:text-white transition-colors">Contact</a></li>
              </ul>
            </div>
            <div>
              <h4 className="text-xs tracking-widest text-primary mb-4 uppercase">About Us</h4>
              <ul className="space-y-3 text-sm text-gray-400">
                <li><a href="#" className="hover:text-white transition-colors">Overview</a></li>
                <li><a href="#" className="hover:text-white transition-colors">Team</a></li>
                <li><a href="#" className="hover:text-white transition-colors">Careers</a></li>
                <li><a href="#" className="hover:text-white transition-colors">Newsroom</a></li>
              </ul>
            </div>
          </div>
          
          {/* Bottom bar */}
          <div className="flex flex-col md:flex-row justify-between items-center pt-8 border-t border-white/10">
            <div className="flex items-center gap-3 mb-4 md:mb-0">
              <Shield className="w-6 h-6 text-primary" />
              <span className="font-semibold text-white tracking-widest text-sm">SENTINEL</span>
            </div>
            
            <div className="flex items-center gap-6">
              {/* Social links */}
              <div className="flex items-center gap-4 text-gray-400">
                <a href="#" className="hover:text-white transition-colors">
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M19 3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h14m-.5 15.5v-5.3a3.26 3.26 0 0 0-3.26-3.26c-.85 0-1.84.52-2.32 1.3v-1.11h-2.79v8.37h2.79v-4.93c0-.77.62-1.4 1.39-1.4a1.4 1.4 0 0 1 1.4 1.4v4.93h2.79M6.88 8.56a1.68 1.68 0 0 0 1.68-1.68c0-.93-.75-1.69-1.68-1.69a1.69 1.69 0 0 0-1.69 1.69c0 .93.76 1.68 1.69 1.68m1.39 9.94v-8.37H5.5v8.37h2.77z"/></svg>
                </a>
                <a href="#" className="hover:text-white transition-colors">
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
                </a>
                <a href="#" className="hover:text-white transition-colors">
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>
                </a>
                <a href="https://github.com" className="hover:text-white transition-colors">
                  <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24"><path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/></svg>
                </a>
              </div>
              
              <Button 
                size="sm" 
                className="bg-transparent border border-primary text-primary hover:bg-primary hover:text-white rounded-full px-6"
              >
                Get Started
              </Button>
            </div>
          </div>
          
          {/* Copyright */}
          <div className="flex flex-col md:flex-row justify-between items-center mt-8 text-xs text-gray-500">
            <div className="flex items-center gap-4 mb-2 md:mb-0">
              <span>En ∨</span>
              <a href="#" className="hover:text-white transition-colors">Privacy Policy</a>
              <a href="#" className="hover:text-white transition-colors">Terms & Conditions</a>
              <a href="mailto:support@sentinel.com" className="hover:text-white transition-colors underline">support@sentinel.com</a>
            </div>
            <span>Copyright © 2026. Sentinel Inc.</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
