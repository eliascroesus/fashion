import { useTranslation } from 'react-i18next';
import { PlaceholderScreen } from '../../components/placeholder-screen';

export default function SearchScreen() {
  const { t } = useTranslation();
  return (
    <PlaceholderScreen title={t('screens.search.title')} body={t('screens.search.comingSoon')} />
  );
}
