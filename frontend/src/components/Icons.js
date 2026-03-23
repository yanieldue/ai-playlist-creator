import React from 'react';
import { FiSettings, FiHome, FiBook, FiUser, FiLogOut, FiMusic, FiMic, FiEdit2, FiZap, FiCheck, FiRefreshCw, FiX, FiInfo, FiSend, FiList, FiChevronLeft, FiChevronRight, FiChevronDown, FiThumbsUp, FiThumbsDown, FiLock, FiLoader, FiEye, FiEyeOff, FiMinusCircle, FiHeadphones, FiLink, FiClipboard, FiPlus, FiHeart, FiStar } from 'react-icons/fi';

// Icon components - using Feather Icons from react-icons
const Icons = {
  Home: ({ size = 24, color = 'currentColor' }) => (
    <FiHome size={size} color={color} />
  ),

  Library: ({ size = 24, color = 'currentColor' }) => (
    <FiBook size={size} color={color} />
  ),

  User: ({ size = 24, color = 'currentColor' }) => (
    <FiUser size={size} color={color} />
  ),

  Settings: ({ size = 24, color = 'currentColor' }) => (
    <FiSettings size={size} color={color} />
  ),

  Logout: ({ size = 24, color = 'currentColor' }) => (
    <FiLogOut size={size} color={color} />
  ),

  Music: ({ size = 24, color = 'currentColor' }) => (
    <FiMusic size={size} color={color} />
  ),

  Microphone: ({ size = 24, color = 'currentColor' }) => (
    <FiMic size={size} color={color} />
  ),

  Edit: ({ size = 24, color = 'currentColor' }) => (
    <FiEdit2 size={size} color={color} />
  ),

  Sparkles: ({ size = 24, color = 'currentColor' }) => (
    <FiZap size={size} color={color} />
  ),

  Check: ({ size = 24, color = 'currentColor' }) => (
    <FiCheck size={size} color={color} />
  ),

  Refresh: ({ size = 24, color = 'currentColor' }) => (
    <FiRefreshCw size={size} color={color} />
  ),

  Close: ({ size = 24, color = 'currentColor' }) => (
    <FiX size={size} color={color} />
  ),

  Info: ({ size = 24, color = 'currentColor' }) => (
    <FiInfo size={size} color={color} />
  ),

  Send: ({ size = 24, color = 'currentColor' }) => (
    <FiSend size={size} color={color} />
  ),

  Playlist: ({ size = 24, color = 'currentColor' }) => (
    <FiList size={size} color={color} />
  ),

  ChevronDown: ({ size = 24, color = 'currentColor' }) => (
    <FiChevronDown size={size} color={color} />
  ),

  ChevronLeft: ({ size = 24, color = 'currentColor' }) => (
    <FiChevronLeft size={size} color={color} />
  ),

  ChevronRight: ({ size = 24, color = 'currentColor' }) => (
    <FiChevronRight size={size} color={color} />
  ),

  Heart: ({ size = 24, color = 'currentColor', fill = false }) => (
    <FiHeart size={size} color={color} style={{ fill: fill ? color : 'none' }} />
  ),

  Star: ({ size = 24, color = 'currentColor', fill = false }) => (
    <FiStar size={size} color={color} style={{ fill: fill ? color : 'none' }} />
  ),

  ThumbsUp: ({ size = 24, color = 'currentColor', fill = false, strokeColor }) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? color : 'none'}
      stroke={fill ? (strokeColor || 'white') : color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'block' }}
    >
      <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3z" />
      <path d="M7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3" />
    </svg>
  ),

  ThumbsDown: ({ size = 24, color = 'currentColor', fill = false, strokeColor }) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill ? color : 'none'}
      stroke={fill ? (strokeColor || 'white') : color}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ display: 'block' }}
    >
      <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3z" />
      <path d="M17 2h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17" />
    </svg>
  ),

  Lock: ({ size = 24, color = 'currentColor' }) => (
    <FiLock size={size} color={color} />
  ),

  Loader: ({ size = 24, color = 'currentColor' }) => (
    <FiLoader size={size} color={color} />
  ),

  Eye: ({ size = 24, color = 'currentColor' }) => (
    <FiEye size={size} color={color} />
  ),

  EyeOff: ({ size = 24, color = 'currentColor' }) => (
    <FiEyeOff size={size} color={color} />
  ),

  MinusCircle: ({ size = 24, color = 'currentColor' }) => (
    <FiMinusCircle size={size} color={color} />
  ),

  Headphones: ({ size = 24, color = 'currentColor' }) => (
    <FiHeadphones size={size} color={color} />
  ),

  Link: ({ size = 24, color = 'currentColor' }) => (
    <FiLink size={size} color={color} />
  ),

  Clipboard: ({ size = 24, color = 'currentColor' }) => (
    <FiClipboard size={size} color={color} />
  ),

  Plus: ({ size = 24, color = 'currentColor' }) => (
    <FiPlus size={size} color={color} />
  ),

};

export default Icons;
