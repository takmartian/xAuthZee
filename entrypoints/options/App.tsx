import { t } from '@/lib/i18n';
import styles from './App.module.css';

export default function App() {
  return (
    <div className={styles.page}>
      <h1 className={styles.heading}>{t('optionsTitle')}</h1>
      <p className={styles.placeholder}>
        账号管理、域名绑定、主密码与导入导出将在后续里程碑接入。
      </p>
    </div>
  );
}
