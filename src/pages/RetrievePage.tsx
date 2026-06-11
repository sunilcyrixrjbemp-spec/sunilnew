import { useState, useEffect, useRef } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import './LoginPage.css'; // Reuse common login layouts

interface PopupState {
  show: boolean;
  title: string;
  message: string;
  type: 'success' | 'error';
  redirectOnClose?: boolean;
}

export default function RetrievePage() {
  const [ecode, setEcode] = useState('');
  const [dob, setDob] = useState('');
  const [doj, setDoj] = useState('');
  const [otp, setOtp] = useState('');
  const [step, setStep] = useState(1); // 1: Details, 2: OTP, 3: Success Result
  const [retrievedId, setRetrievedId] = useState('');
  const [loading, setLoading] = useState(false);
  
  // Timer states
  const [timeLeft, setTimeLeft] = useState(300); // 5 minutes
  const [timerExpired, setTimerExpired] = useState(false);
  const timerIntervalRef = useRef<number | null>(null);

  const [popup, setPopup] = useState<PopupState>({
    show: false,
    title: '',
    message: '',
    type: 'error'
  });

  const navigate = useNavigate();

  useEffect(() => {
    return () => {
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    };
  }, []);

  const startTimer = () => {
    if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
    setTimeLeft(300);
    setTimerExpired(false);
    
    timerIntervalRef.current = window.setInterval(() => {
      setTimeLeft((prev) => {
        if (prev <= 1) {
          if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
          setTimerExpired(true);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  };

  const handleRequestOTP = async (isResend = false) => {
    if (!isResend) {
      setLoading(true);
    }
    
    try {
      const res = await fetch('/api/retrive', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          e_code: ecode,
          dob,
          doj,
          action: 'SEND_OTP'
        })
      });
      const data = await res.json();
      
      if (res.ok && data.success) {
        setStep(2);
        startTimer();
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
      setPopup({
        show: true,
        title: 'Error',
        message: 'Connection failed. Please try again.',
        type: 'error'
      });
    } finally {
      if (!isResend) setLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (step === 1) {
      await handleRequestOTP(false);
    } else {
      setLoading(true);
      try {
        const res = await fetch('/api/retrive', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            e_code: ecode,
            dob,
            doj,
            otp,
            action: 'VERIFY_RETRIEVE'
          })
        });
        const data = await res.json();
        
        if (res.ok && data.success) {
          if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
          setRetrievedId(data.user_id);
          setStep(3);
        } else {
          setPopup({
            show: true,
            title: 'Failed',
            message: data.message || 'OTP verification failed.',
            type: 'error'
          });
        }
      } catch (err) {
        setPopup({
          show: true,
          title: 'Error',
          message: 'Connection failed. Please try again.',
          type: 'error'
        });
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
      {/* Popups */}
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
              OK, Understood
            </button>
          </div>
        </>
      )}

      <div className="login-card">
        <div className="header-text">
          <img src="/logo.png" alt="Cyrix Logo" className="cyrix-img" />
          <h1>Retrieve User ID</h1>
          <p>Verify details to recover your account ID</p>
        </div>

        {step === 3 ? (
          <div style={{ textAlign: 'center', animation: 'popIn 0.4s ease' }}>
            <div style={{
              background: 'var(--success-light)',
              border: '2px solid rgba(16, 185, 129, 0.3)',
              borderRadius: '16px',
              padding: '32px 20px',
              margin: '20px 0'
            }}>
              <p style={{ color: 'var(--success)', fontWeight: 700, fontSize: '14px', marginBottom: '12px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Identity Verified
              </p>
              <h2 style={{ color: 'var(--primary-dark)', fontSize: '36px', fontWeight: 900, fontFamily: 'var(--font-mono)', letterSpacing: '2px', margin: 0 }}>
                {retrievedId}
              </h2>
            </div>
            <button className="submit-btn" onClick={() => navigate('/')}>
              Go to Login Page
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="login-form">
            {step === 1 ? (
              <div>
                <div className="form-group">
                  <label>E-Code <span style={{ color: 'var(--danger)' }}>*</span></label>
                  <input 
                    type="text" 
                    required 
                    placeholder="EMP-XXX"
                    value={ecode}
                    onChange={(e) => setEcode(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>Date of Birth <span style={{ color: 'var(--danger)' }}>*</span></label>
                  <input 
                    type="date" 
                    required
                    value={dob}
                    onChange={(e) => setDob(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>Date of Joining <span style={{ color: 'var(--danger)' }}>*</span></label>
                  <input 
                    type="date" 
                    required
                    value={doj}
                    onChange={(e) => setDoj(e.target.value)}
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
                    value={otp}
                    onChange={(e) => setOtp(e.target.value)}
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
                    {timerExpired ? (
                      <span style={{ color: 'var(--danger)', fontWeight: 700 }}>OTP Expired</span>
                    ) : (
                      <>
                        Expires in:{' '}
                        <span style={{ color: 'var(--danger)', fontFamily: 'var(--font-mono)', fontWeight: 700, marginLeft: '4px' }}>
                          {formatTime(timeLeft)}
                        </span>
                      </>
                    )}
                  </div>
                  <button 
                    type="button" 
                    disabled={!timerExpired}
                    onClick={() => handleRequestOTP(true)}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: timerExpired ? 'var(--primary-light)' : 'var(--text-3)',
                      fontSize: '12px',
                      fontWeight: 700,
                      cursor: timerExpired ? 'pointer' : 'not-allowed',
                      textDecoration: timerExpired ? 'underline' : 'none',
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
              ) : step === 1 ? (
                "Send OTP"
              ) : (
                "Retrieve ID"
              )}
            </button>
            
            <div className="form-footer">
              <Link to="/">&larr; Back to Login</Link>
            </div>
          </form>
        )}

        <footer>
          <p>
            &copy; Designed & Developed by{' '}
            <a href="https://sunilbishnoi.co.in" target="_blank" rel="noopener noreferrer">
              Sunil Bishnoi
            </a>
          </p>
        </footer>
      </div>
    </div>
  );
}
