import React from 'react';
import { FiSettings, FiHome, FiBook, FiUser, FiLogOut, FiMusic, FiMic, FiEdit2, FiZap, FiCheck, FiRefreshCw, FiX, FiInfo, FiSend, FiList, FiChevronLeft, FiChevronRight } from 'react-icons/fi';

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

  ChevronLeft: ({ size = 24, color = 'currentColor' }) => (
    <FiChevronLeft size={size} color={color} />
  ),

  ChevronRight: ({ size = 24, color = 'currentColor' }) => (
    <FiChevronRight size={size} color={color} />
  ),

};

export default Icons;
