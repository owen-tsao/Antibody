"use client";

// Verbatim from 21st.dev (~/.cursor/skills/component-library/prompts/liquid-metal-hero-integration.md)
// with one change, in the <LiquidMetal> props. The paste does `{...liquidMetalPresets[2]}`, written
// against an older @paper-design/shaders-react where presets were flat param objects. In 0.0.80 each
// preset is `{ name, params }`, so the spread passed `name`/`params` (ignored) and the shader fell back
// to its defaults. We spread `.params` (the preset's grey field and rainbow stripes, as intended),
// add `shape="metaballs"` for the morphing blob the demo shows (the current preset has no shape),
// and nudge `repetition` 1.5→2.5 / `softness` .05→.2 so the white stripe bands are narrower and do
// not blow out a whole lobe at once. Nothing else is tuned in the shader.
//
// Styling deviations from the paste (Owen's UI standard): the two CTAs are pills, the primary has
// no drop shadow, the secondary is a transparent outline (the shadcn outline variant fills
// `bg-background`, which rendered as a second solid black button), and the subtitle carries a soft
// text-shadow so white type stays legible over the grey field and the passing blob.

import { LiquidMetal, liquidMetalPresets } from '@paper-design/shaders-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { motion } from 'framer-motion';

interface LiquidMetalHeroProps {
  badge?: string;
  title: string;
  subtitle: string;
  primaryCtaLabel: string;
  secondaryCtaLabel?: string;
  onPrimaryCtaClick: () => void;
  onSecondaryCtaClick?: () => void;
  features?: string[];
}

export default function LiquidMetalHero({
  badge,
  title,
  subtitle,
  primaryCtaLabel,
  secondaryCtaLabel,
  onPrimaryCtaClick,
  onSecondaryCtaClick,
  features = [],
}: LiquidMetalHeroProps) {
  const containerVariants = {
    hidden: { opacity: 0 },
    visible: {
      opacity: 1,
      transition: {
        delayChildren: 0.2,
        staggerChildren: 0.15
      }
    }
  };

  const itemVariants = {
    hidden: { opacity: 0, y: 30 },
    visible: { 
      opacity: 1, 
      y: 0
    }
  };

  const buttonVariants = {
    hidden: { opacity: 0, scale: 0.9 },
    visible: { 
      opacity: 1, 
      scale: 1
    }
  };

  return (
    <section className="relative min-h-screen flex items-center justify-center overflow-hidden">
      <LiquidMetal
        {...liquidMetalPresets[2].params}
        shape="metaballs"
        repetition={2.5}
        softness={0.2}
        style={{ position: "fixed", inset: 0, zIndex: -10 }}
      />
      
      <div className="container mx-auto px-6 lg:px-8 max-w-7xl">
        <motion.div 
          className="text-center space-y-8"
          variants={containerVariants}
          initial="hidden"
          animate="visible"
          transition={{ duration: 0.8, ease: [0.25, 0.1, 0.25, 1] }}
        >
          {badge && (
            <motion.div 
              className="flex justify-center"
              variants={itemVariants}
            >
              <Badge 
                variant="secondary" 
                className="bg-foreground/10 text-foreground border-foreground/20 hover:bg-foreground/20 transition-colors duration-300 backdrop-blur-sm"
              >
                {badge}
              </Badge>
            </motion.div>
          )}
          
          <motion.div 
            className="space-y-6"
            variants={itemVariants}
          >
            <motion.h1 
              role="heading" 
              aria-level={1}
              className="text-5xl sm:text-6xl lg:text-7xl xl:text-8xl font-bold text-foreground leading-tight tracking-tight"
              variants={itemVariants}
            >
              {title}
            </motion.h1>
            
            <motion.p 
              className="max-w-3xl mx-auto text-xl sm:text-2xl text-foreground/90 leading-relaxed"
              style={{ textShadow: "0 1px 24px rgba(0,0,0,0.45), 0 0 2px rgba(0,0,0,0.25)" }}
              variants={itemVariants}
            >
              {subtitle}
            </motion.p>
          </motion.div>
          
          <motion.div 
            className="flex flex-col sm:flex-row gap-3 justify-center items-center"
            variants={buttonVariants}
          >
            <motion.div
              whileHover={{ scale: 1.03 }}
              whileTap={{ scale: 0.97 }}
            >
              <Button 
                onClick={onPrimaryCtaClick}
                size="lg"
                className="rounded-full bg-foreground text-background hover:bg-foreground/90 transition-colors duration-200 text-[15px] px-7 h-12 font-medium"
              >
                {primaryCtaLabel}
              </Button>
            </motion.div>
            
            {secondaryCtaLabel && onSecondaryCtaClick && (
              <motion.div
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
              >
                <Button 
                  onClick={onSecondaryCtaClick}
                  variant="outline"
                  size="lg"
                  className="rounded-full bg-transparent border-foreground/40 text-foreground hover:bg-foreground/10 hover:text-foreground hover:border-foreground/60 transition-colors duration-200 text-[15px] px-7 h-12 font-medium"
                >
                  {secondaryCtaLabel}
                </Button>
              </motion.div>
            )}
          </motion.div>
          
          {features.length > 0 && (
            <motion.div 
              className="pt-12"
              variants={itemVariants}
            >
              <motion.div
                whileHover={{ y: -4 }}
                transition={{ duration: 0.3 }}
              >
                <Card className="bg-foreground/10 border-foreground/20 backdrop-blur-md shadow-2xl">
                  <div className="p-8">
                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                      {features.map((feature, index) => (
                        <motion.div 
                          key={index}
                          className="flex items-center justify-center text-center"
                          initial={{ opacity: 0, x: -20 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ 
                            duration: 0.6, 
                            delay: 0.8 + (index * 0.1)
                          }}
                        >
                          <p className="text-foreground/90 font-medium text-lg">
                            {feature}
                          </p>
                        </motion.div>
                      ))}
                    </div>
                  </div>
                </Card>
              </motion.div>
            </motion.div>
          )}
        </motion.div>
      </div>
    </section>
  );
}
