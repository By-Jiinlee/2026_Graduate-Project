import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'

export default function Register() {
  const [form, setForm] = useState({ name: '', email: '', password: '', confirm: '' })
  const navigate = useNavigate()

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm({ ...form, [e.target.name]: e.target.value })
  }

  const handleRegister = () => {
    if (form.name && form.email && form.password && form.password === form.confirm) {
      navigate('/login')
    }
  }

  return (
    <div style={{
      minHeight: '100vh', backgroundColor: '#f9fafb',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'sans-serif',
    }}>
      <div style={{
        backgroundColor: '#fff', borderRadius: '20px',
        padding: '48px 40px', width: '400px',
        boxShadow: '0 4px 20px rgba(0,0,0,0.08)',
      }}>

        {/* 로고 */}
        <div style={{ textAlign: 'center', marginBottom: '32px' }}>
          <span style={{ fontSize: '28px', fontWeight: 'bold', color: '#3CB371' }}>UpTick</span>
          <span style={{ fontSize: '22px', marginLeft: '6px' }}>📈</span>
          <p style={{ fontSize: '14px', color: '#888', marginTop: '8px' }}>
            회원가입
          </p>
        </div>

        {/* 입력 폼 */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', marginBottom: '24px' }}>
          {[
            { label: '이름', name: 'name', type: 'text', placeholder: '이름을 입력하세요' },
            { label: '이메일', name: 'email', type: 'email', placeholder: '이메일을 입력하세요' },
            { label: '비밀번호', name: 'password', type: 'password', placeholder: '비밀번호를 입력하세요' },
            { label: '비밀번호 확인', name: 'confirm', type: 'password', placeholder: '비밀번호를 다시 입력하세요' },
          ].map(field => (
            <div key={field.name}>
              <label style={{ fontSize: '13px', color: '#555', fontWeight: '600', display: 'block', marginBottom: '6px' }}>
                {field.label}
              </label>
              <input
                type={field.type}
                name={field.name}
                placeholder={field.placeholder}
                value={form[field.name as keyof typeof form]}
                onChange={handleChange}
                style={{
                  width: '100%', padding: '12px 14px',
                  border: '1px solid #ddd', borderRadius: '10px',
                  fontSize: '14px', outline: 'none', boxSizing: 'border-box',
                }}
              />
            </div>
          ))}

          {/* 비밀번호 불일치 경고 */}
          {form.confirm && form.password !== form.confirm && (
            <p style={{ fontSize: '12px', color: '#e53935', margin: 0 }}>
              비밀번호가 일치하지 않습니다.
            </p>
          )}
        </div>

        {/* 회원가입 버튼 */}
        <button
          onClick={handleRegister}
          style={{
            width: '100%', padding: '14px',
            backgroundColor: '#3CB371', color: '#fff',
            border: 'none', borderRadius: '10px',
            fontSize: '15px', fontWeight: '600',
            cursor: 'pointer', marginBottom: '16px',
          }}
        >
          회원가입
        </button>

        {/* 하단 링크 */}
        <div style={{ textAlign: 'center', fontSize: '13px', color: '#888' }}>
          이미 계정이 있으신가요?{' '}
          <Link to="/login" style={{ color: '#3CB371', fontWeight: '600', textDecoration: 'none' }}>
            로그인
          </Link>
        </div>
      </div>
    </div>
  )
}