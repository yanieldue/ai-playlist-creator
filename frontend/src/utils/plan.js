export const getUserPlan = () => localStorage.getItem('userPlan') || 'free';
export const isPaid = () => getUserPlan() === 'paid';

export const setWeeklyLimitResetsAt = (resetsAt) => localStorage.setItem('weeklyLimitResetsAt', resetsAt);
export const isWeeklyLimitActive = () => {
  if (isPaid()) return false;
  const resetsAt = localStorage.getItem('weeklyLimitResetsAt');
  if (!resetsAt) return false;
  return new Date(resetsAt) > new Date();
};
export const getWeeklyLimitResetDate = () => {
  const resetsAt = localStorage.getItem('weeklyLimitResetsAt');
  if (!resetsAt) return null;
  return new Date(resetsAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
};
