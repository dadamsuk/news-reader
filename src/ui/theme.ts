import { useColorScheme } from 'react-native';

export interface Theme {
  dark: boolean;
  bg: string;
  card: string;
  text: string;
  muted: string;
  faint: string;
  border: string;
  accent: string;
  onAccent: string;
  strip: string;
  green: string;
  amber: string;
  red: string;
  save: string;
  dismiss: string;
  banner: string;
  bannerText: string;
}

export const light: Theme = {
  dark: false,
  bg: '#F4F3EF',
  card: '#FFFFFF',
  text: '#16161A',
  muted: '#5F6068',
  faint: '#8E8F96',
  border: '#E2E0D8',
  accent: '#A8201A',
  onAccent: '#FFFFFF',
  strip: '#F1EFE8',
  green: '#2E8B57',
  amber: '#D9941E',
  red: '#C62828',
  save: '#1F6F54',
  dismiss: '#6B6B73',
  banner: '#FFF3CD',
  bannerText: '#5C4400',
};

export const dark: Theme = {
  dark: true,
  bg: '#0E0E10',
  card: '#1A1A1E',
  text: '#ECECEE',
  muted: '#A4A5AD',
  faint: '#77787F',
  border: '#2A2A30',
  accent: '#FF8A80',
  onAccent: '#1A0E0D',
  strip: '#232328',
  green: '#4CC38A',
  amber: '#F0B34A',
  red: '#FF6B6B',
  save: '#2E8B6B',
  dismiss: '#4A4A52',
  banner: '#3D3211',
  bannerText: '#F5E2A6',
};

export function healthColor(t: Theme, h: 'green' | 'amber' | 'red' | 'grey'): string {
  return h === 'green' ? t.green : h === 'amber' ? t.amber : h === 'red' ? t.red : t.border;
}

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}
