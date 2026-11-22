import React, { type ReactNode, useCallback } from 'react';
import { StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { GestureDetector, usePanGesture, type PanGestureActiveEvent } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue, withDelay, withSpring, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

/**
 * A row that can be swiped sideways, built to sit inside a vertical list.
 *
 * Replaces ReanimatedSwipeable, which caused two faults in the feed:
 * - it took over after 10 dp of sideways movement and never yielded to vertical movement, so a
 *   scroll that drifted slightly sideways became a swipe and the list barely moved;
 * - whenever it believed a row was "open" it made the row's content `box-only`, so a row left in
 *   that state by an interrupted drag swallowed every tap.
 *
 * Here the swipe only starts after a clearly horizontal drag (ACTIVATE_X) and fails as soon as the
 * finger moves vertically first (FAIL_Y), leaving the list to scroll. The content never blocks
 * touches, and the row always settles back to rest unless it is committed and slid away.
 */
const ACTIVATE_X = 24;
const FAIL_Y = 12;
const DEFAULT_THRESHOLD = 88;
const SPRING = { damping: 30, stiffness: 300, overshootClamping: true } as const;

export interface SwipeRowProps {
  children: ReactNode;
  /** Swiping right (finger moves right). The row springs back to rest, unless `rightSlidesAway`. */
  onSwipeRight?: () => void;
  /** A right swipe removes the row: it slides off like a left swipe, and comes back if it is not removed. */
  rightSlidesAway?: boolean;
  /** Swiping left (finger moves left). The row slides away; it comes back if it is not removed. */
  onSwipeLeft?: () => void;
  /** Shown behind the row while it is dragged right. */
  renderRightSwipe?: () => ReactNode;
  /** Shown behind the row while it is dragged left. */
  renderLeftSwipe?: () => ReactNode;
  /** Distance (dp, after a velocity toss) a drag must cover to count. */
  threshold?: number;
  style?: StyleProp<ViewStyle>;
}

export function SwipeRow({
  children, onSwipeRight, onSwipeLeft, rightSlidesAway = false, renderRightSwipe, renderLeftSwipe, threshold = DEFAULT_THRESHOLD, style,
}: SwipeRowProps) {
  const tx = useSharedValue(0);
  const width = useSharedValue(0);
  const committed = useSharedValue(false);
  const canRight = !!onSwipeRight;
  const canLeft = !!onSwipeLeft;

  const fireRight = useCallback(() => onSwipeRight?.(), [onSwipeRight]);
  const fireLeft = useCallback(() => onSwipeLeft?.(), [onSwipeLeft]);

  const pan = usePanGesture({
    enabled: canRight || canLeft,
    activeOffsetX: [-ACTIVATE_X, ACTIVATE_X],
    failOffsetY: [-FAIL_Y, FAIL_Y],
    onActivate: () => {
      'worklet';
      committed.value = false;
    },
    onUpdate: (e: PanGestureActiveEvent) => {
      'worklet';
      let x = e.translationX;
      if (x > 0 && !canRight) x = 0;
      if (x < 0 && !canLeft) x = 0;
      tx.value = x;
    },
    onDeactivate: (e: PanGestureActiveEvent) => {
      'worklet';
      const x = e.translationX + 0.08 * e.velocityX;
      if (x > threshold && canRight) {
        committed.value = true;
        if (rightSlidesAway) {
          tx.value = withTiming(width.value || 500, { duration: 160 }, (done) => {
            if (!done) return;
            scheduleOnRN(fireRight);
            tx.value = withDelay(600, withTiming(0, { duration: 0 }));
          });
        } else {
          tx.value = withSpring(0, SPRING);
          scheduleOnRN(fireRight);
        }
      } else if (x < -threshold && canLeft) {
        committed.value = true;
        tx.value = withTiming(-(width.value || 500), { duration: 160 }, (done) => {
          if (!done) return;
          scheduleOnRN(fireLeft);
          // Normally the row is removed now. If it is not (an error), bring it back.
          tx.value = withDelay(600, withTiming(0, { duration: 0 }));
        });
      }
    },
    onFinalize: () => {
      'worklet';
      // Cancelled, released short of the threshold, or interrupted: always return to rest.
      if (!committed.value) tx.value = withSpring(0, SPRING);
    },
  });

  const rowStyle = useAnimatedStyle(() => ({ transform: [{ translateX: tx.value }] }));
  const rightBg = useAnimatedStyle(() => ({ opacity: tx.value > 0 ? 1 : 0 }));
  const leftBg = useAnimatedStyle(() => ({ opacity: tx.value < 0 ? 1 : 0 }));

  return (
    <View style={style} onLayout={(e) => { width.value = e.nativeEvent.layout.width; }}>
      {renderRightSwipe ? <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, rightBg]}>{renderRightSwipe()}</Animated.View> : null}
      {renderLeftSwipe ? <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, leftBg]}>{renderLeftSwipe()}</Animated.View> : null}
      <GestureDetector gesture={pan}>
        <Animated.View style={rowStyle}>{children}</Animated.View>
      </GestureDetector>
    </View>
  );
}
