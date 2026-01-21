import * as SliderPrimitive from '@radix-ui/react-slider'
import { cn } from '@/lib/utils'

interface DualRangeSliderProps {
  value: [number, number]
  onValueChange: (value: [number, number]) => void
  min?: number
  max?: number
  step?: number
  minRange?: number
  className?: string
  leftThumbClassName?: string
  rightThumbClassName?: string
  trackClassName?: string
  rangeClassName?: string
  disabled?: boolean
}

export function DualRangeSlider({
  value,
  onValueChange,
  min = 0,
  max = 100,
  step = 1,
  minRange = 5,
  className,
  leftThumbClassName,
  rightThumbClassName,
  trackClassName,
  rangeClassName,
  disabled = false,
}: DualRangeSliderProps) {
  const handleValueChange = (newValue: number[]) => {
    // Ensure minimum gap between values
    if (newValue[1] - newValue[0] < minRange) {
      return
    }
    onValueChange([newValue[0], newValue[1]])
  }

  return (
    <SliderPrimitive.Root
      className={cn(
        'relative flex w-full touch-none select-none items-center',
        disabled && 'opacity-50 cursor-not-allowed',
        className
      )}
      value={value}
      onValueChange={handleValueChange}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      minStepsBetweenThumbs={Math.ceil(minRange / step)}
    >
      <SliderPrimitive.Track
        className={cn(
          'relative h-2 w-full grow overflow-hidden rounded-full bg-muted',
          trackClassName
        )}
      >
        <SliderPrimitive.Range
          className={cn('absolute h-full bg-yellow-500/50', rangeClassName)}
        />
      </SliderPrimitive.Track>

      {/* Left thumb (maybe threshold) */}
      <SliderPrimitive.Thumb
        className={cn(
          'block h-5 w-5 rounded-full border-2 border-yellow-500 bg-background ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none',
          leftThumbClassName
        )}
      />

      {/* Right thumb (definite threshold) */}
      <SliderPrimitive.Thumb
        className={cn(
          'block h-5 w-5 rounded-full border-2 border-green-500 bg-background ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none',
          rightThumbClassName
        )}
      />
    </SliderPrimitive.Root>
  )
}
