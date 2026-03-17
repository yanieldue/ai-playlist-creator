import React, { useEffect } from 'react';
import Icons from './Icons';
import '../styles/Toast.css';

const Toast = ({ message, type = 'success', onClose, duration = 3000 }) => {
  useEffect(() => {
    const timer = setTimeout(() => {
      onClose();
    }, duration);

    return () => clearTimeout(timer);
  }, [duration, onClose]);

  const getIcon = () => {
    switch (type) {
      case 'success': return <Icons.Check size={18} />;
      case 'error':   return <Icons.Close size={18} />;
      case 'info':    return <Icons.Info size={18} />;
      default:        return <Icons.Check size={18} />;
    }
  };

  return (
    <div className={`toast toast-${type}`}>
      <div className="toast-icon">{getIcon()}</div>
      <div className="toast-message">{message}</div>
    </div>
  );
};

export default Toast;
