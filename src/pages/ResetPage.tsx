import { useState, useEffect, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import './LoginPage.css';

interface PopupState {
  show: boolean;
  title: string;
  message: string;
  type: 'success' | 'error';
  redirectOnClose?: boolean;
}

export default function ResetPage() {
  const [activeTab, setActiveTab] = useState<'forgot' | 'unlock'>('forgot');
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  // Forgot Password Tab States
  const [fUser, setFUser] = useState('');
  const [fDob, setFDob] = useState('');
  const [fDoj, setFDoj] = useState('');
  const [fOtp, setFOtp] = useState('');
  const [fPass, setFPass] = useState('');
  const [fConf, setFConf] = useState('');
  const [fStep, setFStep] = useState(1); // 1: Details, 2: OTP & New Password
  const [fTimeLeft, setFTimeLeft] = useState(300);
  const [fTimerExpired, setFTimerExpired] = useState(false);
  const fTimerRef = useRef<number | null>(null);
  const [fPassError, setFPassError] = useState(false);

  // Unlock Account Tab States
  const [uUser, setUUser] = useState('');
  const [uEcode, setUEcode] = useState('');
  const [uDob, setUDob] = useState('');
  const [uDoj, setUDoj] = useState('');
  const [uOtp, setUOtp] = useState('');
  const [uStep, setUStep] = useState(1); // 1: Details, 2: OTP Verify
  const [uTimeLeft, setUTimeLeft] = useState(300);
  const [uTimerExpired, setUTimerExpired] = useState(false);
  const uTimerRef = useRef<number | null>(null);

  const [popup, setPopup] = useState<PopupState>({
    show: false,
    title: '',
    message: '',
    type: 'error'
  });

  useEffect(() => {
    return () => {
      if (fTimerRef.current) clearInterval(fTimerRef.current);
      if (uTimerRef.current) clearInterval(uTimerRef.current);
    };
  }, []);

  const switchTab = (tab: 'forgot' | 'unlock') => {
    setActiveTab(tab);
    if (fTimerRef.current) clearInterval(fTimerRef.current);
    if (uTimerRef.current) clearInterval(uTimerRef.current);
    
    // Reset steps
    setFStep(1);
    setUStep(1);
    setFOtp('');
    setFPass('');
    setFConf('');
    setUOtp('');
    setTimerExpiredStates();
  };

  const setTimerExpiredStates = () => {
    setFTimerExpired(false);
    setUTimerExpired(false);
    setFTimeLeft(300);
    setUTimeLeft(300);
  };

  const startForgotTimer = () => {
    if (fTimerRef.current) clearInterval(fTimerRef.current);
    setFTimeLeft(300);
    setFTimerExpired(false);
    
    fTimerRef.current = window.setInterval(() => {
      setFTimeLeft((prev) => {
        if (prev <= 1) {
          if (fTimerRef.current) clearInterval(fTimerRef.current);
          setFTimerExpired(true);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const startUnlockTimer = () => {
    if (uTimerRef.current) clearInterval(uTimerRef.current);
    setUTimeLeft(300);
    setUTimerExpired(false);
    
    uTimerRef.current = window.setInterval(() => {
      setUTimeLeft((prev) => {
        if (prev <= 1) {
          if (uTimerRef.current) clearInterval(uTimerRef.current);
          setUTimerExpired(true);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  // ── Forgot Password Logic ──
  const requestForgotOTP = async (isResend = false) => {
    if (!isResend) setLoading(true);
    try {
      const res = await fetch('/api/forgot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: fUser,
          dob: fDob,
          doj: fDoj,
          action: 'SEND_OTP'
        })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setFStep(2);
        startForgotTimer();
        if (isResend) {
          setPopup({
            show: true,
            title: 'OTP Sent',
            message: 'A new verification code has been sent to your registered email.',
            type: 'success'
          });
        }
      } else {
        setPopup({
          show: true,
          title: 'Verification Failed',
          message: data.message || 'Verification details did not match.',
          type: 'error'
        });
      }
    } catch (err) {
      setPopup({ show: true, title: 'Error', message: 'Connection Error', type: 'error' });
    } finally {
      if (!isResend) setLoading(false);
    }
  };

  const handleForgotSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (fStep === 1) {
      await requestForgotOTP(false);
    } else {
      if (fPass !== fConf) {
        setFPassError(true);
        return;
      }
      setFPassError(false);
      setLoading(true);

      try {
        const res = await fetch('/api/forgot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id: fUser,
            dob: fDob,
            doj: fDoj,
            otp: fOtp,
            new_password: fPass,
            action: 'VERIFY_RESET'
          })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          if (fTimerRef.current) clearInterval(fTimerRef.current);
          setPopup({
            show: true,
            title: 'Password Reset!',
            message: 'Your password has been changed successfully.',
            type: 'success',
            redirectOnClose: true
          });
        } else {
          setPopup({ show: true, title: 'Failed', message: data.message || 'Reset failed.', type: 'error' });
        }
      } catch (err) {
        setPopup({ show: true, title: 'Error', message: 'Update Failed', type: 'error' });
      } finally {
        setLoading(false);
      }
    }
  };

  // ── Unlock Account Logic ──
  const requestUnlockOTP = async (isResend = false) => {
    if (!isResend) setLoading(true);
    try {
      const res = await fetch('/api/unlock', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: uUser,
          e_code: uEcode,
          dob: uDob,
          doj: uDoj,
          action: 'SEND_OTP'
        })
      });
      const data = await res.json();
      if (res.ok && data.success) {
        setUStep(2);
        startUnlockTimer();
        if (isResend) {
          setPopup({
            show: true,
            title: 'OTP Sent',
            message: 'A new verification code has been sent to your registered email.',
            type: 'success'
          });
        }
      } else {
        setPopup({
          show: true,
          title: 'Verification Failed',
          message: data.message || 'Verification failed.',
          type: 'error'
        });
      }
    } catch (err) {
      setPopup({ show: true, title: 'Error', message: 'Connection Error', type: 'error' });
    } finally {
      if (!isResend) setLoading(false);
    }
  };

  const handleUnlockSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (uStep === 1) {
      await requestUnlockOTP(false);
    } else {
      setLoading(true);
      try {
        const res = await fetch('/api/unlock', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            user_id: uUser,
            e_code: uEcode,
            dob: uDob,
            doj: uDoj,
            otp: uOtp,
            action: 'VERIFY_UNLOCK'
          })
        });
        const data = await res.json();
        if (res.ok && data.success) {
          if (uTimerRef.current) clearInterval(uTimerRef.current);
          setPopup({
            show: true,
            title: 'Account Unlocked!',
            message: 'Your account is now active. You can login.',
            type: 'success',
            redirectOnClose: true
          });
        } else {
          setPopup({ show: true, title: 'Failed', message: data.message || 'Unlock failed.', type: 'error' });
        }
      } catch (err) {
        setPopup({ show: true, title: 'Error', message: 'Unlock Failed', type: 'error' });
      } finally {
        setLoading(false);
      }
    }
  };

  const closePopup = () => {
    setPopup((prev) => ({ ...prev, show: false }));
    if (popup.redirectOnClose) {
      navigate('/');
    }
  };

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  };

  return (
    <div className="login-container">
      {/* Custom Popup Overlay */}
      {popup.show && (
        <>
          <div className="popup-overlay" onClick={closePopup}></div>
          <div className="custom-popup">
            <div className={`icon-wrapper ${popup.type}`}>
              {popup.type === 'success' ? (
                <svg width="32" height="32" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="32" height="32" fill="none" stroke="currentColor" strokeWidth="2.5" viewBox="0 0 24 24">
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              )}
            </div>
            <h3 style={{ color: 'var(--primary-dark)', fontSize: '18px', marginBottom: '8px', fontWeight: 800 }}>
              {popup.title}
            </h3>
            <p style={{ color: 'var(--text-2)', fontSize: '14px', marginBottom: '24px', fontWeight: 500, lineHeight: 1.5 }}>
              {popup.message}
            </p>
            <button className="submit-btn" onClick={closePopup} style={{ margin: 0 }}>
              {popup.type === 'success' ? "Login Now" : "OK, Understood"}
            </button>
          </div>
        </>
      )}

      <div className="login-card">
        <div className="header-text">
          <img src="/logo.png" alt="Cyrix Logo" className="cyrix-img" />
          <h1>Account Help</h1>
          <p>Verify identity to proceed</p>
        </div>

        {/* Tab Switcher */}
        <div style={{
          display: 'flex',
          background: 'var(--surface-2)',
          padding: '6px',
          borderRadius: '14px',
          marginBottom: '24px'
        }}>
          <button 
            type="button"
            onClick={() => switchTab('forgot')}
            style={{
              flex: 1,
              padding: '12px',
              borderRadius: '10px',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'all var(--t-fast)',
              background: activeTab === 'forgot' ? 'var(--surface)' : 'transparent',
              color: activeTab === 'forgot' ? 'var(--primary-dark)' : 'var(--text-2)',
              boxShadow: activeTab === 'forgot' ? 'var(--shadow-sm)' : 'none',
              border: 'none'
            }}
          >
            Forgot Password
          </button>
          <button 
            type="button"
            onClick={() => switchTab('unlock')}
            style={{
              flex: 1,
              padding: '12px',
              borderRadius: '10px',
              fontSize: '13px',
              fontWeight: 600,
              cursor: 'pointer',
              transition: 'all var(--t-fast)',
              background: activeTab === 'unlock' ? 'var(--surface)' : 'transparent',
              color: activeTab === 'unlock' ? 'var(--primary-dark)' : 'var(--text-2)',
              boxShadow: activeTab === 'unlock' ? 'var(--shadow-sm)' : 'none',
              border: 'none'
            }}
          >
            Unlock Account
          </button>
        </div>

        {/* ── Forgot Password Form ── */}
        {activeTab === 'forgot' && (
          <form onSubmit={handleForgotSubmit} className="login-form">
            {fStep === 1 ? (
              <div>
                <div className="form-group">
                  <label>User ID <span style={{ color: 'var(--danger)' }}>*</span></label>
                  <input 
                    type="text" 
                    required 
                    placeholder="RJ001"
                    value={fUser}
                    onChange={(e) => setFUser(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>Date of Birth <span style={{ color: 'var(--danger)' }}>*</span></label>
                  <input 
                    type="date" 
                    required
                    value={fDob}
                    onChange={(e) => setFDob(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>Date of Joining <span style={{ color: 'var(--danger)' }}>*</span></label>
                  <input 
                    type="date" 
                    required
                    value={fDoj}
                    onChange={(e) => setFDoj(e.target.value)}
                  />
                </div>
              </div>
            ) : (
              <div>
                <div className="form-group" style={{ marginBottom: '8px' }}>
                  <label>Verification Code <span style={{ color: 'var(--danger)' }}>*</span></label>
                  <input 
                    type="text" 
                    required 
                    maxLength={6} 
                    placeholder="000000"
                    value={fOtp}
                    onChange={(e) => setFOtp(e.target.value)}
                    style={{
                      textAlign: 'center',
                      letterSpacing: '8px',
                      fontWeight: 800,
                      fontSize: '18px',
                      fontFamily: 'var(--font-mono)'
                    }}
                  />
                </div>
                
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginTop: '12px',
                  padding: '0 4px',
                  marginBottom: '16px'
                }}>
                  <div style={{ fontSize: '12px', color: 'var(--text-2)', fontWeight: 600 }}>
                    {fTimerExpired ? (
                      <span style={{ color: 'var(--danger)', fontWeight: 700 }}>OTP Expired</span>
                    ) : (
                      <>
                        Expires in:{' '}
                        <span style={{ color: 'var(--danger)', fontFamily: 'var(--font-mono)', fontWeight: 700, marginLeft: '4px' }}>
                          {formatTime(fTimeLeft)}
                        </span>
                      </>
                    )}
                  </div>
                  <button 
                    type="button" 
                    disabled={!fTimerExpired}
                    onClick={() => requestForgotOTP(true)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: fTimerExpired ? 'var(--primary-light)' : 'var(--text-3)',
                      fontSize: '12px',
                      fontWeight: 700,
                      cursor: fTimerExpired ? 'pointer' : 'not-allowed',
                      textDecoration: fTimerExpired ? 'underline' : 'none',
                      padding: 0
                    }}
                  >
                    Resend OTP
                  </button>
                </div>

                <div className="form-group">
                  <label>New Password <span style={{ color: 'var(--danger)' }}>*</span></label>
                  <input 
                    type="password" 
                    required
                    placeholder="Enter new password"
                    value={fPass}
                    onChange={(e) => setFPass(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>Confirm Password <span style={{ color: 'var(--danger)' }}>*</span></label>
                  <input 
                    type="password" 
                    required
                    placeholder="Confirm new password"
                    value={fConf}
                    onChange={(e) => setFConf(e.target.value)}
                  />
                </div>
                {fPassError && (
                  <div style={{
                    background: 'var(--danger-light)',
                    color: 'var(--danger)',
                    padding: '10px',
                    borderRadius: '8px',
                    fontSize: '13px',
                    fontWeight: 500,
                    border: '1px solid rgba(239, 68, 68, 0.2)',
                    marginBottom: '16px',
                    textAlign: 'center'
                  }}>
                    Passwords do not match!
                  </div>
                )}
              </div>
            )}

            <button type="submit" className="submit-btn" disabled={loading}>
              {loading ? (
                <>
                  <span className="spinner"></span>
                  <span>Processing...</span>
                </>
              ) : fStep === 1 ? (
                "Send OTP"
              ) : (
                "Reset Password"
              )}
            </button>
          </form>
        )}

        {/* ── Unlock Account Form ── */}
        {activeTab === 'unlock' && (
          <form onSubmit={handleUnlockSubmit} className="login-form">
            {uStep === 1 ? (
              <div>
                <div className="form-group">
                  <label>User ID <span style={{ color: 'var(--danger)' }}>*</span></label>
                  <input 
                    type="text" 
                    required 
                    placeholder="RJ001"
                    value={uUser}
                    onChange={(e) => setUUser(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>E-Code <span style={{ color: 'var(--danger)' }}>*</span></label>
                  <input 
                    type="text" 
                    required 
                    placeholder="EMP-XXX"
                    value={uEcode}
                    onChange={(e) => setUEcode(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>Date of Birth <span style={{ color: 'var(--danger)' }}>*</span></label>
                  <input 
                    type="date" 
                    required
                    value={uDob}
                    onChange={(e) => setUDob(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>Date of Joining <span style={{ color: 'var(--danger)' }}>*</span></label>
                  <input 
                    type="date" 
                    required
                    value={uDoj}
                    onChange={(e) => setUDoj(e.target.value)}
                  />
                </div>
              </div>
            ) : (
              <div>
                <div className="form-group" style={{ marginBottom: '8px' }}>
                  <label>Verification Code <span style={{ color: 'var(--danger)' }}>*</span></label>
                  <input 
                    type="text" 
                    required 
                    maxLength={6} 
                    placeholder="000000"
                    value={uOtp}
                    onChange={(e) => setUOtp(e.target.value)}
                    style={{
                      textAlign: 'center',
                      letterSpacing: '8px',
                      fontWeight: 800,
                      fontSize: '18px',
                      fontFamily: 'var(--font-mono)'
                    }}
                  />
                </div>
                
                <div style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  marginTop: '12px',
                  padding: '0 4px'
                }}>
                  <div style={{ fontSize: '12px', color: 'var(--text-2)', fontWeight: 600 }}>
                    {uTimerExpired ? (
                      <span style={{ color: 'var(--danger)', fontWeight: 700 }}>OTP Expired</span>
                    ) : (
                      <>
                        Expires in:{' '}
                        <span style={{ color: 'var(--danger)', fontFamily: 'var(--font-mono)', fontWeight: 700, marginLeft: '4px' }}>
                          {formatTime(uTimeLeft)}
                        </span>
                      </>
                    )}
                  </div>
                  <button 
                    type="button" 
                    disabled={!uTimerExpired}
                    onClick={() => requestUnlockOTP(true)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: uTimerExpired ? 'var(--primary-light)' : 'var(--text-3)',
                      fontSize: '12px',
                      fontWeight: 700,
                      cursor: uTimerExpired ? 'pointer' : 'not-allowed',
                      textDecoration: uTimerExpired ? 'underline' : 'none',
                      padding: 0
                    }}
                  >
                    Resend OTP
                  </button>
                </div>
              </div>
            )}

            <button type="submit" className="submit-btn" disabled={loading} style={{ marginTop: '25px' }}>
              {loading ? (
                <>
                  <span className="spinner"></span>
                  <span>Processing...</span>
                </>
              ) : uStep === 1 ? (
                "Send OTP"
              ) : (
                "Unlock Account"
              )}
            </button>
          </form>
        )}

        <div className="form-footer">
          <Link to="/">&larr; Back to Login</Link>
        </div>
      </div>
    </div>
  );
}
