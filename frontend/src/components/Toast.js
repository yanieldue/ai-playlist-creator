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
      case 'success':
        return <Icons.Check size={20} />;
      case 'error':
        return <Icons.Close size={20} />;
      case 'info':
        return <Icons.Info size={20} />;
      default:
        return <Icons.Check size={20} />;
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
