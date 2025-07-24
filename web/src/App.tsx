import UploadArea from './components/UploadArea'

export default function App() {
  return (
    <div className="min-h-screen bg-gradient-to-br from-blue-100 to-purple-100 p-6">
      <h1 className="text-3xl font-bold text-center mb-6 text-blue-800">Healthcare Claim Parser</h1>
      <UploadArea />
    </div>
  )
}
