import { useTranslation } from 'react-i18next';
import { PlaceholderScreen } from '../../components/placeholder-screen';

export default function SavedScreen() {
  const { t } = useTranslation();
  return (
    <PlaceholderScreen title={t('screens.saved.title')} body={t('screens.saved.comingSoon')} />
  );
}
