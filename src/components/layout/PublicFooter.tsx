import Link from 'next/link';
import Image from 'next/image';
import { Linkedin, Twitter, Github } from 'lucide-react';

interface PublicFooterProps {
  appName?: string;
}

const QUICK_LINKS = [
  { href: '/#features', label: 'Features' },
  { href: '/#how-it-works', label: 'How It Works' },
  { href: '/#pricing', label: 'Pricing' },
  { href: '/#contact', label: 'Contact' },
];

const SOCIALS = [
  { href: 'https://www.linkedin.com/', label: 'LinkedIn', Icon: Linkedin },
  { href: 'https://twitter.com/', label: 'Twitter', Icon: Twitter },
  { href: 'https://github.com/', label: 'GitHub', Icon: Github },
];

export function PublicFooter({ appName = 'OmniSight' }: PublicFooterProps) {
  return (
    <footer className="border-t border-border/60 bg-muted/30">
      <div className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <div className="grid gap-8 sm:grid-cols-2 md:grid-cols-4">
          {/* Brand */}
          <div className="md:col-span-2">
            <Link href="/" className="flex items-center gap-2.5" aria-label={`${appName} home`}>
              <span className="relative h-8 w-8">
                <Image
                  src="/logos/omnisight.svg"
                  alt={`${appName} logo`}
                  fill
                  sizes="32px"
                  className="object-contain"
                />
              </span>
              <span className="text-lg font-semibold tracking-tight text-foreground">
                {appName}
              </span>
            </Link>
            <p className="mt-4 max-w-sm text-sm text-muted-foreground">
              Workforce intelligence, built for privacy. Real-time monitoring,
              AI insights, and full self-hosting on your own infrastructure.
            </p>
          </div>

          {/* Quick links */}
          <div>
            <h3 className="text-sm font-semibold text-foreground">Quick Links</h3>
            <ul className="mt-4 space-y-2.5">
              {QUICK_LINKS.map((link) => (
                <li key={link.label}>
                  <Link
                    href={link.href}
                    className="text-sm text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </div>

          {/* Social */}
          <div>
            <h3 className="text-sm font-semibold text-foreground">Follow Us</h3>
            <div className="mt-4 flex items-center gap-3">
              {SOCIALS.map(({ href, label, Icon }) => (
                <a
                  key={label}
                  href={href}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={label}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-border/60 hover:text-foreground"
                >
                  <Icon className="h-4.5 w-4.5" />
                </a>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-10 border-t border-border/60 pt-6 text-center text-xs text-muted-foreground">
          © {new Date().getFullYear()} {appName}. All rights reserved.
        </div>
      </div>
    </footer>
  );
}
