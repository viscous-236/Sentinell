'use client'

import { Button } from '@/components/ui/button'
import { ArrowRight, Shield, Zap, Lock, Eye } from 'lucide-react'

export default function Home() {
  return (
    <div className="min-h-screen bg-background text-foreground overflow-hidden">
      {/* Gradient Background */}
      <div
        className="fixed inset-0 z-0"
        style={{
          backgroundImage: `url('/images/image3.jpg')`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
        }}
      />

      {/* Dark Overlay with subtle gradient */}
      <div className="fixed inset-0 bg-gradient-to-b from-black/60 via-black/50 to-black/70 z-0" />

      {/* Cyan glow effects */}
      <div className="fixed top-0 left-1/4 w-96 h-96 bg-primary/20 rounded-full blur-[120px] z-0" />
      <div className="fixed bottom-0 right-1/4 w-96 h-96 bg-accent/15 rounded-full blur-[120px] z-0" />

      {/* Content */}
      <div className="relative z-10">
        {/* Navigation */}
        <nav className="flex items-center justify-between px-6 md:px-12 py-6 backdrop-blur-md bg-black/20 border-b border-white/10">
          <div className="flex items-center gap-2">
            <Shield className="w-8 h-8 text-primary" />
            <span className="text-2xl font-bold text-primary racing-sans-one-regular">
              Sentinel
            </span>
          </div>
          <div className="hidden md:flex items-center gap-8">
            <a href="#features" className="text-sm text-gray-300 hover:text-primary transition-colors">
              Features
            </a>
            <a href="#how-it-works" className="text-sm text-gray-300 hover:text-primary transition-colors">
              How It Works
            </a>
            <a href="#security" className="text-sm text-gray-300 hover:text-primary transition-colors">
              Security
            </a>
            <a href="/docs" className="text-sm text-gray-300 hover:text-primary transition-colors">
              Docs
            </a>
            <Button variant="default" className="bg-primary hover:bg-primary/80 text-white shadow-lg shadow-primary/50">
              Launch App
            </Button>
          </div>
        </nav>

        {/* Hero Section */}
        <section className="px-6 md:px-12 py-20 md:py-25">
          <div className="max-w-4xl mx-auto text-center">
            <div className="mb-6 inline-block px-6 py-2 bg-white/5 backdrop-blur-md rounded-full border border-primary/30 shadow-lg shadow-primary/20">
              <p className="text-sm text-gray-200">
                Verifiable AI • Cross-Chain • MEV Protected
              </p>
            </div>

            <h1 className="text-5xl md:text-8xl font-bold mb-10 leading-[1.0] racing-sans-one-regular">
              <span className="text-white">Autonomous</span>
              <span className="block text-primary">
                DeFi Security
              </span>
            </h1>

            <p className="text-lg md:text-xl text-gray-300 mb-8 max-w-2xl mx-auto leading-relaxed">
              Sentinel uses verifiable AI agents running inside Trusted Execution Environments to protect your liquidity from MEV attacks and oracle manipulation across multiple chains.
            </p>

            <div className="flex flex-col sm:flex-row gap-4 justify-center">
              <Button
                size="lg"
                className="bg-primary hover:bg-primary/80 text-white px-8 py-6 text-lg shadow-2xl shadow-primary/50 transition-all hover:scale-105"
              >
                Get Started
                <ArrowRight className="w-5 h-5 ml-2" />
              </Button>
              <a href="/docs">
                <Button
                  variant="outline"
                  size="lg"
                  className="border-primary/50 hover:bg-primary/10 px-8 py-6 text-lg bg-white/5 backdrop-blur-md hover:border-primary transition-all hover:scale-105"
                >
                  View Docs
                </Button>
              </a>
            </div>
          </div>
        </section>

        {/* Features Section */}
        <section id="features" className="px-6 md:px-12 py-20">
          <div className="max-w-6xl mx-auto">
            <h2 className="text-4xl md:text-5xl font-bold text-center mb-4 text-white racing-sans-one-regular">
              Built for Security
            </h2>
            <p className="text-center text-gray-300 mb-16 text-lg">
              Enterprise-grade protection for DeFi protocols
            </p>

            <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6">
              {[
                {
                  icon: Shield,
                  title: 'MEV Protection',
                  description: 'Advanced detection and mitigation of mempool-based attacks',
                  color: 'from-primary/80 to-primary/40',
                },
                {
                  icon: Eye,
                  title: 'Oracle Validation',
                  description: 'Multi-source price verification across chains',
                  color: 'from-accent/80 to-accent/40',
                },
                {
                  icon: Zap,
                  title: 'Instant Response',
                  description: 'Sub-second decision making with Yellow state channels',
                  color: 'from-primary/60 to-accent/60',
                },
                {
                  icon: Lock,
                  title: 'Verifiable Compute',
                  description: 'TEE-backed execution with cryptographic proofs',
                  color: 'from-accent/60 to-primary/60',
                },
              ].map((feature, idx) => (
                <div
                  key={idx}
                  className="group p-6 bg-white/5 backdrop-blur-md border border-primary/20 rounded-xl hover:border-primary/60 hover:bg-white/10 transition-all hover:scale-105 hover:shadow-2xl hover:shadow-primary/30"
                >
                  <div className={`w-12 h-12 rounded-lg bg-gradient-to-br ${feature.color} p-3 mb-4 text-white shadow-lg`}>
                    <feature.icon className="w-full h-full" />
                  </div>
                  <h3 className="text-lg font-semibold mb-2 text-white">{feature.title}</h3>
                  <p className="text-gray-400 text-sm">{feature.description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* How It Works Section */}
        <section id="how-it-works" className="px-6 md:px-12 py-20 bg-black/30 backdrop-blur-md border-y border-white/10">
          <div className="max-w-4xl mx-auto">
            <h2 className="text-4xl md:text-5xl font-bold text-center mb-4 text-white racing-sans-one-regular">
              How Sentinel Works
            </h2>
            <p className="text-center text-gray-300 mb-16 text-lg">
              Multi-agent architecture for trustless security
            </p>

            <div className="space-y-6">
              {[
                {
                  num: '01',
                  title: 'Scout Agent',
                  description: 'Monitors mempools and detects weak signals across chains',
                },
                {
                  num: '02',
                  title: 'Validator Agent',
                  description: 'Verifies threats against multiple oracle sources',
                },
                {
                  num: '03',
                  title: 'Risk Engine',
                  description: 'Correlates signals into deterministic defense decisions',
                },
                {
                  num: '04',
                  title: 'Executor Agent',
                  description: 'Activates Uniswap v4 hooks with cryptographic verification',
                },
              ].map((step, idx) => (
                <div key={idx} className="flex gap-6 items-start group">
                  <div className="flex-shrink-0">
                    <div className="w-16 h-16 rounded-lg bg-gradient-to-br from-primary to-accent flex items-center justify-center shadow-lg shadow-primary/40 group-hover:shadow-xl group-hover:shadow-primary/60 transition-all group-hover:scale-110">
                      <span className="text-2xl font-bold text-white">{step.num}</span>
                    </div>
                  </div>
                  <div className="flex-1 pt-2 p-6 bg-white/5 backdrop-blur-sm border border-primary/10 rounded-lg group-hover:border-primary/40 group-hover:bg-white/10 transition-all">
                    <h3 className="text-xl font-semibold mb-2 text-white">{step.title}</h3>
                    <p className="text-gray-300">{step.description}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Security Section */}
        <section id="security" className="px-6 md:px-12 py-20">
          <div className="max-w-4xl mx-auto">
            <h2 className="text-4xl md:text-5xl font-bold text-center mb-4 text-white racing-sans-one-regular">
              Security First
            </h2>
            <p className="text-center text-gray-300 mb-12 text-lg">
              Powered by cryptographic verification and Trusted Execution Environments
            </p>

            <div className="grid md:grid-cols-3 gap-6">
              <div className="p-6 bg-white/5 backdrop-blur-md border border-primary/20 rounded-xl hover:border-primary/60 hover:bg-white/10 transition-all hover:scale-105 hover:shadow-xl hover:shadow-primary/20">
                <h3 className="text-lg font-semibold mb-3 text-primary">TEE Execution</h3>
                <p className="text-gray-400">
                  All agent operations occur inside secure enclaves with deterministic code hashes and private key protection.
                </p>
              </div>
              <div className="p-6 bg-white/5 backdrop-blur-md border border-primary/20 rounded-xl hover:border-primary/60 hover:bg-white/10 transition-all hover:scale-105 hover:shadow-xl hover:shadow-primary/20">
                <h3 className="text-lg font-semibold mb-3 text-primary">Remote Attestation</h3>
                <p className="text-gray-400">
                  Cryptographic proofs verify correct code execution and agent identity without exposing private keys.
                </p>
              </div>
              <div className="p-6 bg-white/5 backdrop-blur-md border border-primary/20 rounded-xl hover:border-primary/60 hover:bg-white/10 transition-all hover:scale-105 hover:shadow-xl hover:shadow-primary/20">
                <h3 className="text-lg font-semibold mb-3 text-primary">Non-Custodial</h3>
                <p className="text-gray-400">
                  Users maintain full control of their assets with automated responses that respect protocol rules.
                </p>
              </div>
            </div>
          </div>
        </section>

        {/* CTA Section */}
        <section className="px-6 md:px-12 py-20 relative overflow-hidden">
          <div className="max-w-2xl mx-auto text-center relative z-10">
            <h2 className="text-4xl md:text-5xl font-bold mb-6 text-white racing-sans-one-regular">
              Ready to Protect Your Liquidity?
            </h2>
            <p className="text-xl text-gray-300 mb-8">
              Join the future of autonomous DeFi security with verifiable AI
            </p>
            <Button
              size="lg"
              className="bg-primary hover:bg-primary/80 text-white px-10 py-6 text-lg shadow-2xl shadow-primary/60 transition-all hover:scale-110"
            >
              Launch Sentinel
              <ArrowRight className="w-5 h-5 ml-2" />
            </Button>
          </div>
        </section>

        {/* Footer */}
        <footer className="px-6 md:px-12 py-12 border-t border-primary/20 bg-black/40 backdrop-blur-md">
          <div className="max-w-6xl mx-auto grid md:grid-cols-4 gap-8 mb-8">
            <div>
              <div className="flex items-center gap-2 mb-4">
                <Shield className="w-6 h-6 text-primary" />
                <span className="font-bold text-primary">Sentinel</span>
              </div>
              <p className="text-sm text-gray-400">
                Verifiable AI security infrastructure for DeFi
              </p>
            </div>
            <div>
              <h4 className="font-semibold mb-4 text-white">Product</h4>
              <ul className="space-y-2 text-sm text-gray-400">
                <li><a href="#" className="hover:text-primary transition-colors">Features</a></li>
                <li><a href="#" className="hover:text-primary transition-colors">Security</a></li>
                <li><a href="#" className="hover:text-primary transition-colors">Pricing</a></li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold mb-4 text-white">Resources</h4>
              <ul className="space-y-2 text-sm text-gray-400">
                <li><a href="/docs" className="hover:text-primary transition-colors">Documentation</a></li>
                <li><a href="#" className="hover:text-primary transition-colors">API Reference</a></li>
                <li><a href="#" className="hover:text-primary transition-colors">GitHub</a></li>
              </ul>
            </div>
            <div>
              <h4 className="font-semibold mb-4 text-white">Legal</h4>
              <ul className="space-y-2 text-sm text-gray-400">
                <li><a href="#" className="hover:text-primary transition-colors">Privacy</a></li>
                <li><a href="#" className="hover:text-primary transition-colors">Terms</a></li>
                <li><a href="#" className="hover:text-primary transition-colors">Security</a></li>
              </ul>
            </div>
          </div>
          <div className="border-t border-primary/20 pt-8 text-center text-sm text-gray-400">
            <p>&copy; 2026 Sentinel. All rights reserved.</p>
          </div>
        </footer>
      </div>
    </div>
  )
}
