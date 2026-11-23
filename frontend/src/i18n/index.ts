import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from "./en.json"
import es from "./es.json"

declare module "i18next" {
    interface CustomTypeOptions { resources: { translation: typeof en } }
}

i18n
    .use(initReactI18next)
    .init({
        lng: 'en',
        fallbackLng: 'en',
        resources: { 
            en: { translation: en }, 
            es: { translation: es }
        },
        interpolation: { escapeValue: false },
        returnEmptyString: false,
    })

/** Locale for dates and times. Plain "es" uses a 24-hour clock; es-US keeps "3:30 p.m." */
export const dateLocale = () => (i18n.language === "es" ? "es-US" : i18n.language);

export default i18n;
